// bot/bot.js
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

// ==================== КОНФИГУРАЦИЯ ====================
const token = process.env.BOT_TOKEN || 'YOUR_BOT_TOKEN';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || 'YOUR_GEMINI_API_KEY';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent?key=${GEMINI_API_KEY}`;
const MINI_APP_URL = process.env.MINI_APP_URL || 'https://your-username.github.io/student-bot';

// Создаем бота
const bot = new TelegramBot(token, { 
    polling: {
        interval: 300,
        autoStart: true,
        params: { timeout: 30 }
    }
});

// ==================== АДМИН-ПАНЕЛЬ ====================
const ADMINS = [5772748918];

const isAdmin = (userId) => ADMINS.includes(Number(userId));

let botStats = {
    startTime: new Date(),
    messagesProcessed: 0,
    commandsUsed: {},
    errors: [],
    usersCount: 0,
    lastRestart: null
};

// Состояния пользователей (для выбора университета)
const userStates = {};

const updateStats = (command) => {
    botStats.messagesProcessed++;
    botStats.commandsUsed[command] = (botStats.commandsUsed[command] || 0) + 1;
};

const updateUsersCount = async () => {
    try {
        const users = await new Promise((resolve, reject) => {
            db.get('SELECT COUNT(*) as count FROM users', [], (err, row) => {
                if (err) reject(err);
                resolve(row.count);
            });
        });
        botStats.usersCount = users;
    } catch (error) {
        console.error('Error getting users count:', error);
    }
};

// ==================== УНИВЕРСИТЕТЫ ====================

// Загрузка университетов из JSON
let universitiesData = {};
try {
    const universitiesPath = path.join(__dirname, '..', 'interfax.json');
    if (fs.existsSync(universitiesPath)) {
        universitiesData = JSON.parse(fs.readFileSync(universitiesPath, 'utf8'));
        console.log('✅ Университеты загружены:', Object.keys(universitiesData).length, 'городов');
    }
} catch (error) {
    console.error('❌ Ошибка загрузки университетов:', error);
}

// Получить список городов
const getCities = () => {
    return Object.keys(universitiesData).sort();
};

// Получить университеты города
const getUniversitiesByCity = (city) => {
    return universitiesData[city] || [];
};

// Поиск города по вхождению
const findCity = (query) => {
    const cities = getCities();
    const lowerQuery = query.toLowerCase();
    return cities.filter(city => city.toLowerCase().includes(lowerQuery));
};

// Поиск университета по названию
const findUniversity = (city, query) => {
    const universities = getUniversitiesByCity(city);
    const lowerQuery = query.toLowerCase();
    return universities.filter(u => u.name.toLowerCase().includes(lowerQuery));
};

// Сохранить университет пользователя
const setUserUniversity = async (userId, university) => {
    try {
        const user = await User.findByPk(userId);
        let settings = {};
        
        if (user && user.settings) {
            settings = typeof user.settings === 'string' ? JSON.parse(user.settings) : user.settings;
        }
        
        settings.university = {
            id: university.id,
            name: university.name,
            city: university.city,
            point: university.point,
            url: university.url
        };
        
        await User.update(userId, { settings: JSON.stringify(settings) });
        return true;
    } catch (error) {
        console.error('Error setting user university:', error);
        return false;
    }
};

// Получить университет пользователя
const getUserUniversity = async (userId) => {
    try {
        const user = await User.findByPk(userId);
        if (!user) return null;
        
        let settings = {};
        if (user.settings) {
            settings = typeof user.settings === 'string' ? JSON.parse(user.settings) : user.settings;
        }
        
        return settings.university || null;
    } catch (error) {
        console.error('Error getting user university:', error);
        return null;
    }
};

// ==================== ФУНКЦИЯ ДЛЯ СБРОСА ВСЕХ ДАННЫХ ПРИ СМЕНЕ УНИВЕРСИТЕТА ====================

const resetUserData = async (userId) => {
    return new Promise((resolve, reject) => {
        db.serialize(() => {
            db.run('DELETE FROM lessons WHERE user_id = ?', [userId], (err) => {
                if (err) console.error('Error deleting lessons:', err);
            });
            
            db.run('DELETE FROM deadlines WHERE user_id = ?', [userId], (err) => {
                if (err) console.error('Error deleting deadlines:', err);
            });
            
            db.run('DELETE FROM notes WHERE user_id = ?', [userId], (err) => {
                if (err) console.error('Error deleting notes:', err);
            });
            
            // Сбрасываем прогресс пользователя
            db.run('UPDATE users SET level = 1, experience = 0, group_name = "Не указана" WHERE user_id = ?', [userId], (err) => {
                if (err) {
                    console.error('Error resetting user progress:', err);
                    reject(err);
                } else {
                    console.log(`✅ Данные пользователя ${userId} сброшены при смене университета`);
                    resolve(true);
                }
            });
        });
    });
};

// ==================== СИСТЕМА НЕДЕЛЬ ====================

// Типы систем недель
const WEEK_SYSTEMS = {
    ONE_WEEK: 'one_week',     // Однонедельная система
    TWO_WEEK: 'two_week'      // Двухнедельная система
};

// Типы недель для двухнедельной системы
const WEEK_TYPES = {
    FIRST: 'first',   // Первая неделя
    SECOND: 'second'  // Вторая неделя
};

// Форматирование типа недели для отображения
const formatWeekType = (weekType) => {
    const types = {
        'first': '📗 Первая неделя',
        'second': '📕 Вторая неделя',
        'both': '📘 Каждую неделю'
    };
    return types[weekType] || weekType;
};

// Определение текущей недели для двухнедельной системы
const getCurrentTwoWeekType = () => {
    const now = new Date();
    // Начало учебного года (1 сентября)
    const startOfYear = new Date(now.getFullYear(), 8, 1);
    
    if (now < startOfYear) {
        startOfYear.setFullYear(startOfYear.getFullYear() - 1);
    }
    
    const diffDays = Math.floor((now - startOfYear) / (1000 * 60 * 60 * 24));
    const weekNumber = Math.floor(diffDays / 7) + 1;
    
    // Четная неделя - вторая, нечетная - первая
    return weekNumber % 2 === 0 ? WEEK_TYPES.SECOND : WEEK_TYPES.FIRST;
};

// Получение типа недели для конкретной даты (для двухнедельной системы)
const getWeekTypeForDate = (date) => {
    const targetDate = new Date(date);
    const startOfYear = new Date(targetDate.getFullYear(), 8, 1);
    
    if (targetDate < startOfYear) {
        startOfYear.setFullYear(startOfYear.getFullYear() - 1);
    }
    
    const diffDays = Math.floor((targetDate - startOfYear) / (1000 * 60 * 60 * 24));
    const weekNumber = Math.floor(diffDays / 7) + 1;
    
    return weekNumber % 2 === 0 ? WEEK_TYPES.SECOND : WEEK_TYPES.FIRST;
};

// Получение информации о текущей неделе для пользователя
const getWeekInfoForUser = async (userId) => {
    const settings = await getUserWeekSettings(userId);
    
    if (settings.system === WEEK_SYSTEMS.ONE_WEEK) {
        return {
            system: 'one_week',
            systemText: '📅 Однонедельная система',
            current: null,
            currentText: 'Каждая неделя одинаковая'
        };
    } else {
        const currentType = getCurrentTwoWeekType();
        return {
            system: 'two_week',
            systemText: '🔄 Двухнедельная система',
            current: currentType,
            currentText: formatWeekType(currentType),
            next: currentType === WEEK_TYPES.FIRST ? WEEK_TYPES.SECOND : WEEK_TYPES.FIRST,
            nextText: formatWeekType(currentType === WEEK_TYPES.FIRST ? WEEK_TYPES.SECOND : WEEK_TYPES.FIRST)
        };
    }
};

// Получение настроек пользователя для типа недели
const getUserWeekSettings = async (userId) => {
    try {
        const user = await User.findByPk(userId);
        if (!user) return { system: WEEK_SYSTEMS.TWO_WEEK };
        
        let settings = {};
        if (user.settings) {
            settings = typeof user.settings === 'string' ? JSON.parse(user.settings) : user.settings;
        }
        
        return {
            system: settings.weekSystem || WEEK_SYSTEMS.TWO_WEEK
        };
    } catch (error) {
        console.error('Error getting user week settings:', error);
        return { system: WEEK_SYSTEMS.TWO_WEEK };
    }
};

// Обновление настроек типа недели пользователя
const updateUserWeekSettings = async (userId, system) => {
    try {
        const user = await User.findByPk(userId);
        let currentSettings = {};
        
        if (user && user.settings) {
            currentSettings = typeof user.settings === 'string' ? JSON.parse(user.settings) : user.settings;
        }
        
        currentSettings.weekSystem = system;
        
        await User.update(userId, { settings: JSON.stringify(currentSettings) });
        return true;
    } catch (error) {
        console.error('Error updating user week settings:', error);
        return false;
    }
};

// Получение активного типа недели для пользователя с учетом его системы
const getActiveWeekTypeForUser = async (userId, date = null) => {
    const settings = await getUserWeekSettings(userId);
    
    if (settings.system === WEEK_SYSTEMS.ONE_WEEK) {
        return 'both'; // В однонедельной системе все пары идут каждую неделю
    } else {
        if (date) {
            return getWeekTypeForDate(date);
        } else {
            return getCurrentTwoWeekType();
        }
    }
};

// ==================== БАЗА ДАННЫХ ====================
const DB_PATH = path.join(__dirname, '..', 'data', 'database.sqlite');
const dataDir = path.join(__dirname, '..', 'data');

if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('❌ Ошибка подключения к БД:', err.message);
    } else {
        console.log('✅ Подключено к SQLite базе данных');
        initTables();
    }
});

// Инициализация таблиц
function initTables() {
    db.serialize(() => {
        // Таблица пользователей (обновленная с поддержкой университета)
        db.run(`CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            name TEXT,
            username TEXT,
            group_name TEXT DEFAULT 'Не указана',
            registered_at DATETIME,
            level INTEGER DEFAULT 1,
            experience INTEGER DEFAULT 0,
            settings TEXT DEFAULT '{"notifications":true,"darkTheme":false,"lessonReminders":true,"deadlineReminders":true,"weekSystem":"two_week"}'
        )`);

        // Таблица расписания
        db.run(`CREATE TABLE IF NOT EXISTS lessons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            date TEXT,
            day TEXT,
            time TEXT,
            subject TEXT,
            room TEXT,
            teacher TEXT,
            week_type TEXT DEFAULT 'both',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Таблица дедлайнов
        db.run(`CREATE TABLE IF NOT EXISTS deadlines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            subject TEXT,
            task TEXT,
            date TEXT,
            priority TEXT CHECK(priority IN ('high', 'medium', 'low')),
            completed BOOLEAN DEFAULT 0,
            completed_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Таблица заметок
        db.run(`CREATE TABLE IF NOT EXISTS notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            title TEXT,
            content TEXT,
            preview TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Таблица групп
        db.run(`CREATE TABLE IF NOT EXISTS groups (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            owner_id TEXT NOT NULL,
            invite_code TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            settings TEXT DEFAULT '{}'
        )`);

        // Таблица участников групп
        db.run(`CREATE TABLE IF NOT EXISTS group_members (
            group_id TEXT,
            user_id TEXT,
            role TEXT DEFAULT 'member',
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            points INTEGER DEFAULT 0,
            PRIMARY KEY (group_id, user_id),
            FOREIGN KEY (group_id) REFERENCES groups(id),
            FOREIGN KEY (user_id) REFERENCES users(user_id)
        )`);

        // Таблица общих пар группы
        db.run(`CREATE TABLE IF NOT EXISTS group_lessons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT,
            date TEXT,
            day TEXT,
            time TEXT,
            subject TEXT,
            room TEXT,
            teacher TEXT,
            week_type TEXT DEFAULT 'both',
            created_by TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES groups(id)
        )`);

        console.log('✅ Таблицы созданы/проверены');
    });
}

// ==================== ФУНКЦИИ ДЛЯ РАБОТЫ С БД ====================

// Пользователи
const User = {
    findOrCreate: (userId, userData) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err, row) => {
                if (err) reject(err);
                if (row) {
                    resolve({ user: row, created: false });
                } else {
                    const settings = JSON.stringify({
                        notifications: true,
                        darkTheme: false,
                        lessonReminders: true,
                        deadlineReminders: true,
                        weekSystem: WEEK_SYSTEMS.TWO_WEEK
                    });
                    
                    db.run(
                        'INSERT INTO users (user_id, name, username, registered_at, settings) VALUES (?, ?, ?, ?, ?)',
                        [userId, userData.name, userData.username, new Date().toISOString(), settings],
                        function(err) {
                            if (err) reject(err);
                            resolve({ 
                                user: { 
                                    user_id: userId, 
                                    name: userData.name,
                                    username: userData.username,
                                    group_name: 'Не указана',
                                    level: 1,
                                    experience: 0,
                                    settings: settings
                                }, 
                                created: true 
                            });
                        }
                    );
                }
            });
        });
    },
    
    findByPk: (userId) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE user_id = ?', [userId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
    },
    
    update: (userId, data) => {
        return new Promise((resolve, reject) => {
            const fields = Object.keys(data).map(key => `${key} = ?`).join(', ');
            const values = [...Object.values(data), userId];
            
            db.run(`UPDATE users SET ${fields} WHERE user_id = ?`, values, function(err) {
                if (err) reject(err);
                resolve(this.changes);
            });
        });
    },
    
    addExperience: (userId, exp) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT experience, level FROM users WHERE user_id = ?', [userId], (err, row) => {
                if (err) reject(err);
                
                let newExp = (row?.experience || 0) + exp;
                let newLevel = row?.level || 1;
                
                while (newExp >= newLevel * 100) {
                    newExp -= newLevel * 100;
                    newLevel++;
                }
                
                db.run(
                    'UPDATE users SET experience = ?, level = ? WHERE user_id = ?',
                    [newExp, newLevel, userId],
                    function(err) {
                        if (err) reject(err);
                        resolve({ newExp, newLevel, leveledUp: newLevel > (row?.level || 1) });
                    }
                );
            });
        });
    }
};

// Расписание
const Lesson = {
    findAll: (userId, weekType = null) => {
        return new Promise((resolve, reject) => {
            let query = 'SELECT * FROM lessons WHERE user_id = ?';
            let params = [userId];
            
            if (weekType && weekType !== 'both') {
                query += ' AND (week_type = ? OR week_type = "both")';
                params.push(weekType);
            }
            
            query += ' ORDER BY date, time';
            
            db.all(query, params, (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
    },
    
    create: (data) => {
        return new Promise((resolve, reject) => {
            const { user_id, date, day, time, subject, room, teacher, week_type = 'both' } = data;
            db.run(
                'INSERT INTO lessons (user_id, date, day, time, subject, room, teacher, week_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [user_id, date, day, time, subject, room, teacher, week_type],
                function(err) {
                    if (err) reject(err);
                    resolve({ id: this.lastID, ...data });
                }
            );
        });
    },
    
    findByDate: (userId, date) => {
        return new Promise(async (resolve, reject) => {
            try {
                const weekType = await getActiveWeekTypeForUser(userId, date);
                
                db.all(
                    'SELECT * FROM lessons WHERE user_id = ? AND (date = ? OR (day = ? AND (week_type = ? OR week_type = "both"))) ORDER BY time',
                    [userId, date, new Date(date).toLocaleDateString('ru-RU', { weekday: 'long' }), weekType],
                    (err, rows) => {
                        if (err) reject(err);
                        resolve(rows);
                    }
                );
            } catch (error) {
                reject(error);
            }
        });
    },
    
    findByDay: (userId, day, weekType = null) => {
        return new Promise(async (resolve, reject) => {
            try {
                let query = 'SELECT * FROM lessons WHERE user_id = ? AND day = ?';
                let params = [userId, day];
                
                const activeWeekType = weekType || await getActiveWeekTypeForUser(userId);
                
                if (activeWeekType !== 'both') {
                    query += ' AND (week_type = ? OR week_type = "both")';
                    params.push(activeWeekType);
                }
                
                query += ' ORDER BY time';
                
                db.all(query, params, (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                });
            } catch (error) {
                reject(error);
            }
        });
    },
    
    getByWeekType: (userId, weekType) => {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM lessons WHERE user_id = ? AND (week_type = ? OR week_type = "both") ORDER BY day, time',
                [userId, weekType],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });
    },
    
    delete: (id) => {
        return new Promise((resolve, reject) => {
            db.run('DELETE FROM lessons WHERE id = ?', [id], function(err) {
                if (err) reject(err);
                resolve(this.changes);
            });
        });
    }
};

// Дедлайны
const Deadline = {
    findAll: (userId, completed = false) => {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM deadlines WHERE user_id = ? AND completed = ? ORDER BY date',
                [userId, completed ? 1 : 0], 
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });
    },
    
    create: (data) => {
        return new Promise((resolve, reject) => {
            const { user_id, subject, task, date, priority } = data;
            db.run(
                'INSERT INTO deadlines (user_id, subject, task, date, priority) VALUES (?, ?, ?, ?, ?)',
                [user_id, subject, task, date, priority],
                function(err) {
                    if (err) reject(err);
                    resolve({ id: this.lastID, ...data, completed: false });
                }
            );
        });
    },
    
    markComplete: (id) => {
        return new Promise((resolve, reject) => {
            db.run(
                'UPDATE deadlines SET completed = 1, completed_at = ? WHERE id = ?',
                [new Date().toISOString(), id],
                function(err) {
                    if (err) reject(err);
                    resolve(this.changes);
                }
            );
        });
    },
    
    getUpcoming: (userId, days = 7) => {
        return new Promise((resolve, reject) => {
            const futureDate = new Date();
            futureDate.setDate(futureDate.getDate() + days);
            const futureStr = futureDate.toISOString().split('T')[0];
            
            db.all(
                'SELECT * FROM deadlines WHERE user_id = ? AND completed = 0 AND date <= ? ORDER BY date',
                [userId, futureStr],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });
    }
};

// Заметки
const Note = {
    findAll: (userId) => {
        return new Promise((resolve, reject) => {
            db.all('SELECT * FROM notes WHERE user_id = ? ORDER BY created_at DESC', [userId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
    },
    
    create: (data) => {
        return new Promise((resolve, reject) => {
            const { user_id, title, content, preview } = data;
            db.run(
                'INSERT INTO notes (user_id, title, content, preview) VALUES (?, ?, ?, ?)',
                [user_id, title, content, preview],
                function(err) {
                    if (err) reject(err);
                    resolve({ id: this.lastID, ...data });
                }
            );
        });
    },
    
    search: (userId, query) => {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM notes WHERE user_id = ? AND (title LIKE ? OR content LIKE ?) ORDER BY created_at DESC',
                [userId, `%${query}%`, `%${query}%`],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });
    },
    
    delete: (id) => {
        return new Promise((resolve, reject) => {
            db.run('DELETE FROM notes WHERE id = ?', [id], function(err) {
                if (err) reject(err);
                resolve(this.changes);
            });
        });
    }
};

// ==================== ФУНКЦИИ ДЛЯ ГРУПП ====================

const Group = {
    create: (name, ownerId) => {
        return new Promise((resolve, reject) => {
            const groupId = 'group_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            const inviteCode = Math.random().toString(36).substr(2, 8).toUpperCase();
            
            db.run(
                'INSERT INTO groups (id, name, owner_id, invite_code) VALUES (?, ?, ?, ?)',
                [groupId, name, ownerId, inviteCode],
                function(err) {
                    if (err) reject(err);
                    
                    db.run(
                        'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
                        [groupId, ownerId, 'owner'],
                        function(err) {
                            if (err) reject(err);
                            resolve({ 
                                id: groupId, 
                                name, 
                                inviteCode,
                                ownerId 
                            });
                        }
                    );
                }
            );
        });
    },
    
    findById: (groupId) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT * FROM groups WHERE id = ?', [groupId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
    },
    
    findByInviteCode: (code) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT * FROM groups WHERE invite_code = ?', [code], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
    },
    
    getUserGroups: (userId) => {
        return new Promise((resolve, reject) => {
            db.all(`
                SELECT g.*, gm.role, gm.points 
                FROM groups g
                JOIN group_members gm ON g.id = gm.group_id
                WHERE gm.user_id = ?
                ORDER BY gm.joined_at DESC
            `, [userId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
    },
    
    join: (inviteCode, userId) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT * FROM groups WHERE invite_code = ?', [inviteCode], (err, group) => {
                if (err) reject(err);
                if (!group) {
                    reject(new Error('Группа не найдена'));
                    return;
                }
                
                db.get('SELECT * FROM group_members WHERE group_id = ? AND user_id = ?', 
                    [group.id, userId], (err, member) => {
                    if (err) reject(err);
                    if (member) {
                        reject(new Error('Вы уже в этой группе'));
                        return;
                    }
                    
                    db.run(
                        'INSERT INTO group_members (group_id, user_id, role) VALUES (?, ?, ?)',
                        [group.id, userId, 'member'],
                        function(err) {
                            if (err) reject(err);
                            resolve(group);
                        }
                    );
                });
            });
        });
    },
    
    getMembers: (groupId) => {
        return new Promise((resolve, reject) => {
            db.all(`
                SELECT gm.*, u.name, u.username, u.level 
                FROM group_members gm
                JOIN users u ON gm.user_id = u.user_id
                WHERE gm.group_id = ?
                ORDER BY gm.points DESC
            `, [groupId], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
    },
    
    getUserRole: (groupId, userId) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', 
                [groupId, userId], (err, row) => {
                if (err) reject(err);
                resolve(row?.role || null);
            });
        });
    },
    
    addPoints: (groupId, userId, points, reason) => {
        return new Promise((resolve, reject) => {
            db.run(
                'UPDATE group_members SET points = points + ? WHERE group_id = ? AND user_id = ?',
                [points, groupId, userId],
                function(err) {
                    if (err) reject(err);
                    resolve(this.changes);
                }
            );
        });
    },
    
    getLeaderboard: (groupId, limit = 10) => {
        return new Promise((resolve, reject) => {
            db.all(`
                SELECT gm.user_id, u.name, u.username, gm.points, gm.role
                FROM group_members gm
                JOIN users u ON gm.user_id = u.user_id
                WHERE gm.group_id = ?
                ORDER BY gm.points DESC
                LIMIT ?
            `, [groupId, limit], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
    },
    
    addGroupLesson: (groupId, lessonData, userId) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', 
                [groupId, userId], (err, row) => {
                if (err) reject(err);
                if (!row || (row.role !== 'owner' && row.role !== 'admin')) {
                    reject(new Error('Недостаточно прав'));
                    return;
                }
                
                const { date, day, time, subject, room, teacher, week_type = 'both' } = lessonData;
                db.run(
                    'INSERT INTO group_lessons (group_id, date, day, time, subject, room, teacher, week_type, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    [groupId, date, day, time, subject, room, teacher, week_type, userId],
                    function(err) {
                        if (err) reject(err);
                        resolve({ id: this.lastID, ...lessonData });
                    }
                );
            });
        });
    },
    
    getGroupLessons: (groupId, date = null) => {
        return new Promise(async (resolve, reject) => {
            try {
                let query = 'SELECT * FROM group_lessons WHERE group_id = ?';
                let params = [groupId];
                
                if (date) {
                    const weekType = getWeekTypeForDate(date);
                    const day = new Date(date).toLocaleDateString('ru-RU', { weekday: 'long' });
                    
                    query += ' AND (date = ? OR (day = ? AND (week_type = ? OR week_type = "both")))';
                    params.push(date, day, weekType);
                }
                
                query += ' ORDER BY date, time';
                
                db.all(query, params, (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                });
            } catch (error) {
                reject(error);
            }
        });
    },
    
    getGroupWeekSchedule: (groupId, weekType) => {
        return new Promise((resolve, reject) => {
            db.all(
                'SELECT * FROM group_lessons WHERE group_id = ? AND (week_type = ? OR week_type = "both") ORDER BY day, time',
                [groupId, weekType],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });
    }
};

// ==================== ПЕРЕХВАТ СООБЩЕНИЙ ДЛЯ СТАТИСТИКИ ====================
const originalSendMessage = bot.sendMessage;

bot.sendMessage = function(chatId, text, options) {
    botStats.messagesProcessed++;
    return originalSendMessage.call(this, chatId, text, options);
};

bot.on('message', (msg) => {
    if (msg.text && !msg.text.startsWith('/')) {
        updateStats('text_message');
    }
});

// ==================== ОБРАБОТЧИКИ ОШИБОК ====================
bot.on('polling_error', (error) => {
    console.log('⚠️ Polling error:', error.message);
    botStats.errors.push({
        time: new Date(),
        message: error.message,
        type: 'polling'
    });
});

bot.on('error', (error) => {
    console.log('⚠️ Bot error:', error.message);
    botStats.errors.push({
        time: new Date(),
        message: error.message,
        type: 'general'
    });
});

process.on('uncaughtException', (error) => {
    console.error('❌ Необработанная ошибка:', error);
    botStats.errors.push({
        time: new Date(),
        message: error.message,
        stack: error.stack,
        type: 'uncaught'
    });
    
    if (botStats.errors.length > 100) {
        botStats.errors = botStats.errors.slice(-100);
    }
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Необработанный reject:', reason);
    botStats.errors.push({
        time: new Date(),
        message: reason?.message || String(reason),
        type: 'unhandled'
    });
});

// ==================== ГЛАВНОЕ МЕНЮ ====================
const mainMenu = {
    reply_markup: {
        keyboard: [
            ['🤖 Спросить Gemini', '📅 Расписание'],
            ['📝 Дедлайны', '📚 Домашние задания'],
            ['📒 Заметки', '📊 Оценки'],
            ['🔔 Напоминания', '👥 Группы'],
            ['⚙️ Настройки', '📱 Открыть Mini App']
        ],
        resize_keyboard: true
    }
};

// ==================== ПРОВЕРКА КЛЮЧЕЙ ====================
if (!token || token === 'YOUR_BOT_TOKEN') {
    console.log('⚠️ ВНИМАНИЕ: Токен бота не установлен!');
} else {
    console.log('✅ Токен бота найден');
}

if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY') {
    console.log('⚠️ ВНИМАНИЕ: API ключ Gemini не установлен!');
    console.log('📝 Получите ключ на https://makersuite.google.com/app/apikey');
} else {
    console.log('✅ API ключ Gemini найден');
}

console.log('📱 Mini App URL:', MINI_APP_URL);

// ==================== АДМИН-КОМАНДЫ ====================

bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    updateStats('/admin');
    
    if (!isAdmin(userId)) {
        bot.sendMessage(chatId, '⛔ У вас нет доступа к админ-панели');
        return;
    }
    
    const adminMenu = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📊 Статистика', callback_data: 'admin_stats' }],
                [{ text: '👥 Пользователи', callback_data: 'admin_users' }],
                [{ text: '📢 Рассылка', callback_data: 'admin_broadcast' }],
                [{ text: '⚙️ База данных', callback_data: 'admin_db' }],
                [{ text: '🔧 Логи ошибок', callback_data: 'admin_errors' }],
                [{ text: '🔄 Перезапуск', callback_data: 'admin_restart' }]
            ]
        }
    };
    
    bot.sendMessage(chatId, '👑 *Админ-панель*\nВыберите действие:', {
        parse_mode: 'Markdown',
        reply_markup: adminMenu.reply_markup
    });
});

// Обработка callback кнопок админки
bot.on('callback_query', async (callbackQuery) => {
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id;
    const data = callbackQuery.data;
    
    if (!data.startsWith('admin_')) return;
    
    if (!isAdmin(userId)) {
        bot.answerCallbackQuery(callbackQuery.id, { text: '⛔ Доступ запрещен' });
        return;
    }
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    switch(data) {
        case 'admin_stats':
            await showAdminStats(chatId);
            break;
        case 'admin_users':
            await showAdminUsers(chatId);
            break;
        case 'admin_broadcast':
            await startBroadcast(chatId);
            break;
        case 'admin_db':
            await showDBStats(chatId);
            break;
        case 'admin_errors':
            await showErrors(chatId);
            break;
        case 'admin_restart':
            await restartBot(chatId);
            break;
    }
});

// Статистика
async function showAdminStats(chatId) {
    await updateUsersCount();
    
    const uptime = Math.floor((new Date() - botStats.startTime) / 1000);
    const hours = Math.floor(uptime / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    
    const stats = 
        `📊 *Статистика бота*\n\n` +
        `🤖 *Общая:*\n` +
        `• Запущен: ${botStats.startTime.toLocaleString('ru-RU')}\n` +
        `• Аптайм: ${hours}ч ${minutes}м\n` +
        `• Обработано сообщений: ${botStats.messagesProcessed}\n` +
        `• Пользователей: ${botStats.usersCount}\n` +
        `• Ошибок: ${botStats.errors.length}\n\n` +
        `📝 *Команды:*\n` +
        Object.entries(botStats.commandsUsed)
            .map(([cmd, count]) => `• ${cmd}: ${count}`)
            .join('\n') || '• Нет данных';
    
    bot.sendMessage(chatId, stats, { parse_mode: 'Markdown' });
}

// Список пользователей
async function showAdminUsers(chatId) {
    try {
        const users = await new Promise((resolve, reject) => {
            db.all('SELECT user_id, name, username, level, experience, registered_at FROM users ORDER BY registered_at DESC LIMIT 20', [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
        
        let message = '👥 *Последние 20 пользователей:*\n\n';
        users.forEach((u, i) => {
            const date = new Date(u.registered_at).toLocaleDateString('ru-RU');
            message += `${i+1}. *${u.name}* (ID: \`${u.user_id}\`)\n`;
            message += `   👤 @${u.username || 'нет'}\n`;
            message += `   🏆 Уровень ${u.level} | Опыт ${u.experience}\n`;
            message += `   📅 Регистрация: ${date}\n\n`;
        });
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '❌ Ошибка загрузки пользователей');
    }
}

// Рассылка
async function startBroadcast(chatId) {
    bot.sendMessage(chatId, 
        '📢 *Режим рассылки*\n\n' +
        'Отправьте сообщение для рассылки всем пользователям.\n' +
        'Можно отправлять текст, фото или документы.\n' +
        'Или /cancel для отмены',
        { parse_mode: 'Markdown' }
    );
    
    bot.once('message', async (msg) => {
        if (msg.text === '/cancel') {
            bot.sendMessage(chatId, '❌ Рассылка отменена');
            return;
        }
        
        const confirmKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: '✅ Отправить', callback_data: 'broadcast_confirm' },
                        { text: '❌ Отмена', callback_data: 'broadcast_cancel' }
                    ]
                ]
            }
        };
        
        bot.broadcastMessage = msg;
        
        let preview = msg.text || msg.caption || '[Медиа]';
        if (preview.length > 200) preview = preview.substring(0, 200) + '...';
        
        bot.sendMessage(chatId, 
            `📢 *Предпросмотр рассылки:*\n\n${preview}\n\nОтправить всем?`,
            {
                parse_mode: 'Markdown',
                reply_markup: confirmKeyboard.reply_markup
            }
        );
    });
}

// Обработка подтверждения рассылки
bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    if (!data.startsWith('broadcast_')) return;
    
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id;
    
    if (!isAdmin(userId)) return;
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    if (data === 'broadcast_confirm' && bot.broadcastMessage) {
        const broadcastMsg = bot.broadcastMessage;
        const sentMsg = await bot.sendMessage(chatId, '📢 Начинаю рассылку...');
        
        try {
            const users = await new Promise((resolve, reject) => {
                db.all('SELECT user_id FROM users', [], (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                });
            });
            
            let success = 0;
            let failed = 0;
            
            for (const user of users) {
                try {
                    if (broadcastMsg.text) {
                        await bot.sendMessage(user.user_id, broadcastMsg.text, { parse_mode: 'Markdown' });
                    } else if (broadcastMsg.photo) {
                        await bot.sendPhoto(user.user_id, broadcastMsg.photo[0].file_id, { 
                            caption: broadcastMsg.caption,
                            parse_mode: 'Markdown'
                        });
                    } else if (broadcastMsg.document) {
                        await bot.sendDocument(user.user_id, broadcastMsg.document.file_id, { 
                            caption: broadcastMsg.caption,
                            parse_mode: 'Markdown'
                        });
                    }
                    success++;
                } catch (e) {
                    failed++;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            
            await bot.editMessageText(
                `✅ Рассылка завершена!\n\n📊 Результаты:\n• Успешно: ${success}\n• Ошибок: ${failed}`,
                {
                    chat_id: chatId,
                    message_id: sentMsg.message_id
                }
            );
        } catch (error) {
            bot.sendMessage(chatId, '❌ Ошибка при рассылке: ' + error.message);
        }
        
        delete bot.broadcastMessage;
    } else if (data === 'broadcast_cancel') {
        bot.sendMessage(chatId, '❌ Рассылка отменена');
        delete bot.broadcastMessage;
    }
});

// Статистика БД
async function showDBStats(chatId) {
    try {
        const stats = await new Promise((resolve, reject) => {
            db.get(`
                SELECT 
                    (SELECT COUNT(*) FROM users) as users,
                    (SELECT COUNT(*) FROM lessons) as lessons,
                    (SELECT COUNT(*) FROM deadlines) as deadlines,
                    (SELECT COUNT(*) FROM notes) as notes,
                    (SELECT COUNT(*) FROM groups) as groups
            `, [], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
        
        const message = 
            `⚙️ *Статистика базы данных*\n\n` +
            `👥 Пользователей: ${stats.users}\n` +
            `📅 Пар: ${stats.lessons}\n` +
            `📝 Дедлайнов: ${stats.deadlines}\n` +
            `📒 Заметок: ${stats.notes}\n` +
            `👥 Групп: ${stats.groups}`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        bot.sendMessage(chatId, '❌ Ошибка загрузки статистики БД');
    }
}

// Логи ошибок
async function showErrors(chatId) {
    const errors = botStats.errors.slice(-10).reverse();
    
    let message = '🔧 *Последние 10 ошибок:*\n\n';
    if (errors.length === 0) {
        message += '✅ Ошибок нет';
    } else {
        errors.forEach((err, i) => {
            message += `${i+1}. *${new Date(err.time).toLocaleString('ru-RU')}*\n`;
            message += `   Тип: ${err.type || 'unknown'}\n`;
            message += `   \`${err.message}\`\n\n`;
        });
    }
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// Перезапуск бота
async function restartBot(chatId) {
    const confirmKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '✅ Да, перезапустить', callback_data: 'restart_confirm' },
                    { text: '❌ Нет', callback_data: 'restart_cancel' }
                ]
            ]
        }
    };
    
    bot.sendMessage(chatId, 
        '🔄 *Перезапуск бота*\n\nВы уверены?',
        {
            parse_mode: 'Markdown',
            reply_markup: confirmKeyboard.reply_markup
        }
    );
}

// Обработка перезапуска
bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    if (!data.startsWith('restart_')) return;
    
    const msg = callbackQuery.message;
    const chatId = msg.chat.id;
    const userId = callbackQuery.from.id;
    
    if (!isAdmin(userId)) return;
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    if (data === 'restart_confirm') {
        await bot.sendMessage(chatId, '🔄 Перезапускаюсь...');
        
        botStats.lastRestart = new Date();
        fs.writeFileSync(
            path.join(__dirname, '..', 'data', 'stats.json'),
            JSON.stringify(botStats, null, 2)
        );
        
        setTimeout(() => process.exit(0), 1000);
    } else {
        bot.sendMessage(chatId, '❌ Перезапуск отменен');
    }
});

// ==================== ФУНКЦИИ ДЛЯ ВЫБОРА УНИВЕРСИТЕТА ====================

// Начало выбора университета
async function startUniversitySelection(chatId, userId) {
    const cities = getCities();
    
    const message = 
        `🎓 *Добро пожаловать в Student Helper!*\n\n` +
        `Для начала работы выбери свой город.\n\n` +
        `Напиши название города (например: Москва, Санкт-Петербург, Казань)...`;
    
    // Сохраняем состояние пользователя
    userStates[userId] = { step: 'waiting_city' };
    
    bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// Показать университеты города
async function showUniversitiesForCity(chatId, userId, city) {
    const universities = getUniversitiesByCity(city);
    
    if (universities.length === 0) {
        bot.sendMessage(chatId, '❌ В этом городе нет университетов в базе');
        return;
    }
    
    // Сортируем по рейтингу
    universities.sort((a, b) => b.point - a.point);
    
    // Создаем кнопки для университетов
    const keyboard = [];
    for (let i = 0; i < Math.min(universities.length, 20); i++) {
        const uni = universities[i];
        keyboard.push([{
            text: `${uni.name} (⭐ ${uni.point})`,
            callback_data: `select_uni_${uni.id}`
        }]);
    }
    
    if (universities.length > 20) {
        keyboard.push([{
            text: `📋 Показать все (${universities.length})`,
            callback_data: `show_all_uni_${city}`
        }]);
    }
    
    keyboard.push([{
        text: '🔙 Выбрать другой город',
        callback_data: 'back_to_city_selection'
    }]);
    
    bot.sendMessage(chatId, 
        `🏛️ *Университеты ${city}:*\n\n` +
        `Выбери свой университет из списка:`,
        {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }
    );
}

// Показать все университеты города
async function showAllUniversities(chatId, userId, city) {
    const universities = getUniversitiesByCity(city);
    universities.sort((a, b) => b.point - a.point);
    
    // Разбиваем на страницы
    const pageSize = 10;
    let currentPage = 1;
    const totalPages = Math.ceil(universities.length / pageSize);
    
    const showPage = (page) => {
        const start = (page - 1) * pageSize;
        const end = start + pageSize;
        const pageUniversities = universities.slice(start, end);
        
        let message = `🏛️ *Все университеты ${city}*\n`;
        message += `Страница ${page}/${totalPages}\n\n`;
        
        pageUniversities.forEach((uni, index) => {
            const num = start + index + 1;
            message += `${num}. *${uni.name}*\n`;
            message += `   ⭐ Рейтинг: ${uni.point}\n`;
            message += `   [Сайт](${uni.url})\n\n`;
        });
        
        const keyboard = [];
        const navButtons = [];
        
        if (page > 1) {
            navButtons.push({ text: '◀️ Назад', callback_data: `uni_page_${city}_${page-1}` });
        }
        if (page < totalPages) {
            navButtons.push({ text: 'Вперед ▶️', callback_data: `uni_page_${city}_${page+1}` });
        }
        
        if (navButtons.length > 0) {
            keyboard.push(navButtons);
        }
        
        keyboard.push([{ text: '🔙 Выбрать университет', callback_data: `select_city_${city}` }]);
        keyboard.push([{ text: '🔙 Выбрать другой город', callback_data: 'back_to_city_selection' }]);
        
        bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: keyboard }
        });
    };
    
    showPage(currentPage);
}

// ==================== КОМАНДА /start (ОБНОВЛЕННАЯ) ====================

bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('/start');
    
    try {
        const { user, created } = await User.findOrCreate(userId, {
            name: msg.from.first_name || 'Пользователь',
            username: msg.from.username || ''
        });
        
        // Проверяем, есть ли у пользователя университет
        const university = await getUserUniversity(userId);
        
        if (!university) {
            // Пользователь новый - начинаем выбор университета
            await startUniversitySelection(chatId, userId);
        } else {
            // Пользователь уже есть - показываем приветствие
            await showMainMenu(chatId, userId, msg.from.first_name);
        }
    } catch (error) {
        console.error('Error in /start:', error);
        bot.sendMessage(chatId, '❌ Ошибка при запуске. Попробуй еще раз.');
    }
});

// Функция показа главного меню
async function showMainMenu(chatId, userId, firstName) {
    const university = await getUserUniversity(userId);
    const weekInfo = await getWeekInfoForUser(userId);
    
    const welcomeMessage = `🎓 Добро пожаловать, ${firstName || 'друг'}! 👋\n\n` +
        (university ? `🏛️ Твой университет: *${university.name}*\n\n` : '');
    
    bot.sendMessage(
        chatId,
        `${welcomeMessage}` +
        `Я твой умный помощник для учёбы 🤖\n\n` +
        `✨ Что я умею:\n` +
        `• Отвечать на вопросы (Gemini AI)\n` +
        `• Хранить расписание (${weekInfo.systemText})\n` +
        `• Отслеживать дедлайны\n` +
        `• Вести заметки и оценки\n` +
        `• Создавать группы с турнирной таблицей\n` +
        `• Напоминать о важном\n` +
        `• Синхронизироваться с Mini App\n\n` +
        `📱 Открой Mini App для удобного управления!`,
        mainMenu
    );
}

// ==================== ОБРАБОТКА СООБЩЕНИЙ ДЛЯ ВЫБОРА ГОРОДА ====================

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    const text = msg.text;
    
    // Пропускаем команды
    if (text.startsWith('/')) return;
    
    // Проверяем состояние пользователя
    const state = userStates[userId];
    if (!state) return;
    
    if (state.step === 'waiting_city') {
        // Ищем город по запросу
        const matchingCities = findCity(text);
        
        if (matchingCities.length === 0) {
            bot.sendMessage(chatId, 
                `❌ Город "${text}" не найден.\n\n` +
                `Попробуй написать по-другому или выбери из списка:\n` +
                getCities().slice(0, 10).join(', ') + '...');
            return;
        }
        
        if (matchingCities.length === 1) {
            // Найден один город - показываем университеты
            const city = matchingCities[0];
            await showUniversitiesForCity(chatId, userId, city);
        } else {
            // Найдено несколько городов - предлагаем выбрать
            const keyboard = {
                reply_markup: {
                    inline_keyboard: matchingCities.map(city => [{
                        text: city,
                        callback_data: `select_city_${city}`
                    }])
                }
            };
            
            bot.sendMessage(chatId, 
                `🔍 Найдено несколько городов:\n\nВыбери свой:`, 
                keyboard
            );
        }
    }
});

// ==================== ОБРАБОТКА CALLBACK КНОПОК ДЛЯ УНИВЕРСИТЕТОВ ====================

bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id.toString();
    const msgId = callbackQuery.message.message_id;
    
    // Выбор города из списка
    if (data.startsWith('select_city_')) {
        const city = data.replace('select_city_', '');
        bot.answerCallbackQuery(callbackQuery.id);
        await showUniversitiesForCity(chatId, userId, city);
    }
    
    // Выбор университета
    else if (data.startsWith('select_uni_')) {
        const uniId = parseInt(data.replace('select_uni_', ''));
        bot.answerCallbackQuery(callbackQuery.id);
        
        // Ищем университет по ID
        let selectedUniversity = null;
        let selectedCity = null;
        
        for (const [city, universities] of Object.entries(universitiesData)) {
            const uni = universities.find(u => u.id === uniId);
            if (uni) {
                selectedUniversity = uni;
                selectedCity = city;
                break;
            }
        }
        
        if (selectedUniversity) {
            // Сохраняем университет
            await setUserUniversity(userId, {
                ...selectedUniversity,
                city: selectedCity
            });
            
            // Удаляем состояние
            delete userStates[userId];
            
            // Обновляем сообщение
            await bot.editMessageText(
                `✅ Университет выбран!\n\n` +
                `🏛️ *${selectedUniversity.name}*\n` +
                `📍 ${selectedCity}\n` +
                `⭐ Рейтинг: ${selectedUniversity.point}\n` +
                `🔗 [Сайт университета](${selectedUniversity.url})`,
                {
                    chat_id: chatId,
                    message_id: msgId,
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                }
            );
            
            // Показываем главное меню
            await showMainMenu(chatId, userId, callbackQuery.from.first_name);
        }
    }
    
    // Показать все университеты города
    else if (data.startsWith('show_all_uni_')) {
        const city = data.replace('show_all_uni_', '');
        bot.answerCallbackQuery(callbackQuery.id);
        await showAllUniversities(chatId, userId, city);
    }
    
    // Страницы университетов
    else if (data.startsWith('uni_page_')) {
        const parts = data.split('_');
        const city = parts[2];
        const page = parseInt(parts[3]);
        
        bot.answerCallbackQuery(callbackQuery.id);
        
        const universities = getUniversitiesByCity(city);
        universities.sort((a, b) => b.point - a.point);
        
        const pageSize = 10;
        const start = (page - 1) * pageSize;
        const end = start + pageSize;
        const pageUniversities = universities.slice(start, end);
        const totalPages = Math.ceil(universities.length / pageSize);
        
        let message = `🏛️ *Все университеты ${city}*\n`;
        message += `Страница ${page}/${totalPages}\n\n`;
        
        pageUniversities.forEach((uni, index) => {
            const num = start + index + 1;
            message += `${num}. *${uni.name}*\n`;
            message += `   ⭐ Рейтинг: ${uni.point}\n`;
            message += `   [Сайт](${uni.url})\n\n`;
        });
        
        const keyboard = [];
        const navButtons = [];
        
        if (page > 1) {
            navButtons.push({ text: '◀️ Назад', callback_data: `uni_page_${city}_${page-1}` });
        }
        if (page < totalPages) {
            navButtons.push({ text: 'Вперед ▶️', callback_data: `uni_page_${city}_${page+1}` });
        }
        
        if (navButtons.length > 0) {
            keyboard.push(navButtons);
        }
        
        keyboard.push([{ text: '🔙 Выбрать университет', callback_data: `select_city_${city}` }]);
        keyboard.push([{ text: '🔙 Выбрать другой город', callback_data: 'back_to_city_selection' }]);
        
        await bot.editMessageText(message, {
            chat_id: chatId,
            message_id: msgId,
            parse_mode: 'Markdown',
            disable_web_page_preview: true,
            reply_markup: { inline_keyboard: keyboard }
        });
    }
    
    // Вернуться к выбору города
    else if (data === 'back_to_city_selection') {
        bot.answerCallbackQuery(callbackQuery.id);
        userStates[userId] = { step: 'waiting_city' };
        
        await bot.editMessageText(
            `🔙 *Выбор города*\n\nНапиши название своего города:`,
            {
                chat_id: chatId,
                message_id: msgId,
                parse_mode: 'Markdown'
            }
        );
    }
});

// ==================== КОМАНДА ДЛЯ ПРОСМОТРА УНИВЕРСИТЕТА ====================

bot.onText(/\/myuniversity/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('/myuniversity');
    
    const university = await getUserUniversity(userId);
    
    if (!university) {
        bot.sendMessage(chatId, 
            '❌ У вас не выбран университет.\n' +
            'Используйте /start чтобы выбрать!'
        );
        return;
    }
    
    const message = 
        `🏛️ *Мой университет*\n\n` +
        `*${university.name}*\n` +
        `📍 ${university.city}\n` +
        `⭐ Рейтинг: ${university.point}\n` +
        `🔗 [Сайт университета](${university.url})`;
    
    bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
    });
});

// ==================== КОМАНДА ДЛЯ СМЕНЫ УНИВЕРСИТЕТА (С ПОЛНЫМ СБРОСОМ ДАННЫХ) ====================

bot.onText(/\/changeuniversity/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('/changeuniversity');
    
    const confirmKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [
                    { text: '✅ Да, сменить и сбросить данные', callback_data: 'change_uni_confirm' },
                    { text: '❌ Отмена', callback_data: 'change_uni_cancel' }
                ]
            ]
        }
    };
    
    bot.sendMessage(chatId, 
        '⚠️ *Смена университета*\n\n' +
        'ВНИМАНИЕ: При смене университета ВСЕ ваши данные будут удалены:\n' +
        '• Расписание\n' +
        '• Дедлайны\n' +
        '• Заметки\n' +
        '• Прогресс и уровень\n\n' +
        'Вы уверены?',
        {
            parse_mode: 'Markdown',
            reply_markup: confirmKeyboard.reply_markup
        }
    );
});

// Обработка смены университета с полным сбросом данных
bot.on('callback_query', async (callbackQuery) => {
    const data = callbackQuery.data;
    if (!data.startsWith('change_uni_')) return;
    
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id.toString();
    const msgId = callbackQuery.message.message_id;
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    if (data === 'change_uni_confirm') {
        // Полностью сбрасываем все данные пользователя
        await resetUserData(userId);
        
        // Удаляем университет из настроек
        const user = await User.findByPk(userId);
        let settings = {};
        
        if (user && user.settings) {
            settings = typeof user.settings === 'string' ? JSON.parse(user.settings) : user.settings;
        }
        
        delete settings.university;
        
        await User.update(userId, { settings: JSON.stringify(settings) });
        
        await bot.editMessageText(
            '✅ Все данные сброшены! Теперь выберите новый университет.',
            {
                chat_id: chatId,
                message_id: msgId
            }
        );
        
        // Начинаем выбор университета заново
        await startUniversitySelection(chatId, userId);
    } else {
        await bot.editMessageText(
            '❌ Смена университета отменена. Ваши данные сохранены.',
            {
                chat_id: chatId,
                message_id: msgId
            }
        );
    }
});

// ==================== MINI APP ====================

// Команда для открытия Mini App
bot.onText(/📱 Открыть Mini App/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    updateStats('📱 Mini App');
    
    bot.sendMessage(chatId, '🎓 *Student Helper Mini App*', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ 
                    text: '📱 Открыть приложение', 
                    web_app: { url: `${MINI_APP_URL}?userId=${userId}` }
                }]
            ]
        }
    });
});

bot.onText(/\/app/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    updateStats('/app');
    
    bot.sendMessage(chatId, '📱 *Открыть Mini App*', {
        parse_mode: 'Markdown',
        reply_markup: {
            inline_keyboard: [
                [{ 
                    text: '📱 Запустить', 
                    web_app: { url: `${MINI_APP_URL}?userId=${userId}` }
                }]
            ]
        }
    });
});

// Обработка данных от Mini App
bot.on('web_app_data', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    
    try {
        const data = JSON.parse(msg.web_app_data.data);
        console.log('📦 Данные от Mini App:', data);
        
        if (data.action === 'get_university') {
            const university = await getUserUniversity(userId);
            await bot.sendMessage(chatId, JSON.stringify({
                action: 'university_data',
                university: university
            }));
        }
        else if (data.action === 'save_schedule') {
            // Сохраняем расписание из таблицы
            const schedule = data.schedule;
            
            // Сначала удаляем старые пары пользователя
            await new Promise((resolve, reject) => {
                db.run('DELETE FROM lessons WHERE user_id = ?', [userId], (err) => {
                    if (err) reject(err);
                    resolve();
                });
            });
            
            // Преобразуем табличное расписание в формат БД
            const daysMap = {
                'monday': 'Понедельник',
                'tuesday': 'Вторник',
                'wednesday': 'Среда',
                'thursday': 'Четверг',
                'friday': 'Пятница',
                'saturday': 'Суббота'
            };
            
            // Для каждой строки и каждого дня создаем запись
            for (const row of schedule) {
                for (const [dayKey, dayName] of Object.entries(daysMap)) {
                    if (row[dayKey] && row[dayKey].trim() !== '') {
                        const lessonText = row[dayKey];
                        // Парсим текст пары (ожидаемый формат: "Предмет Аудитория" или просто название)
                        const parts = lessonText.split(' ');
                        const subject = parts[0] || lessonText;
                        const room = parts.slice(1).join(' ') || '';
                        
                        await Lesson.create({
                            user_id: userId,
                            date: new Date().toISOString().split('T')[0], // текущая дата как заглушка
                            day: dayName,
                            time: row.time,
                            subject: subject,
                            room: room,
                            teacher: '',
                            week_type: 'both'
                        });
                    }
                }
            }
            
            await bot.sendMessage(chatId, '✅ Расписание сохранено!');
        }
        else if (data.action === 'add_lesson') {
            const lesson = data.lesson;
            
            const lessonDate = new Date(lesson.date);
            const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
            const day = days[lessonDate.getDay()];
            
            const newLesson = await Lesson.create({
                user_id: userId,
                date: lesson.date,
                day: day,
                time: lesson.time,
                subject: lesson.subject,
                room: lesson.room,
                teacher: lesson.teacher,
                week_type: lesson.week_type || 'both'
            });
            
            const expResult = await User.addExperience(userId, 10);
            
            const groups = await Group.getUserGroups(userId);
            for (const group of groups) {
                await Group.addPoints(group.id, userId, 5, 'lesson_added');
            }
            
            let message = '✅ Пара добавлена через Mini App!';
            if (expResult.leveledUp) {
                message += `\n\n🎉 Поздравляю! Ты достиг ${expResult.newLevel} уровня!`;
            }
            
            await bot.sendMessage(chatId, message);
        }
        else if (data.action === 'add_deadline') {
            const deadline = data.deadline;
            
            const newDeadline = await Deadline.create({
                user_id: userId,
                subject: deadline.subject,
                task: deadline.task,
                date: deadline.date,
                priority: deadline.priority
            });
            
            const expResult = await User.addExperience(userId, 15);
            
            const groups = await Group.getUserGroups(userId);
            for (const group of groups) {
                await Group.addPoints(group.id, userId, 10, 'deadline_added');
            }
            
            let message = '✅ Дедлайн добавлен через Mini App!';
            if (expResult.leveledUp) {
                message += `\n\n🎉 Поздравляю! Ты достиг ${expResult.newLevel} уровня!`;
            }
            
            await bot.sendMessage(chatId, message);
        }
        else if (data.action === 'complete_deadline') {
            await Deadline.markComplete(data.id);
            
            const expResult = await User.addExperience(userId, 20);
            
            const groups = await Group.getUserGroups(userId);
            for (const group of groups) {
                await Group.addPoints(group.id, userId, 15, 'deadline_completed');
            }
            
            let message = '✅ Задача выполнена! Молодец! 🎉';
            if (expResult.leveledUp) {
                message += `\n\n🎉 Поздравляю! Ты достиг ${expResult.newLevel} уровня!`;
            }
            
            await bot.sendMessage(chatId, message);
        }
        else if (data.action === 'update_week_system') {
            const system = data.system; // 'one_week' или 'two_week'
            await updateUserWeekSettings(userId, system);
            await bot.sendMessage(chatId, `✅ Система недель обновлена на ${system === 'one_week' ? 'однонедельную' : 'двухнедельную'}`);
        }
        else if (data.action === 'update_settings') {
            const user = await User.findByPk(userId);
            if (user) {
                let settings = {};
                if (user.settings) {
                    settings = typeof user.settings === 'string' ? JSON.parse(user.settings) : user.settings;
                }
                
                if (data.setting === 'university') {
                    // Обновление университета из Mini App
                    const university = data.value;
                    await setUserUniversity(userId, university);
                    await bot.sendMessage(chatId, `🏛️ Университет обновлен: ${university.name}`);
                } else {
                    settings[data.setting] = data.value;
                    await User.update(userId, { settings: JSON.stringify(settings) });
                    await bot.sendMessage(chatId, `⚙️ Настройка "${data.setting}" обновлена`);
                }
            }
        }
    } catch (error) {
        console.error('❌ Ошибка обработки Mini App данных:', error);
        botStats.errors.push({
            time: new Date(),
            message: error.message,
            type: 'web_app'
        });
        await bot.sendMessage(chatId, '❌ Ошибка при обработке данных');
    }
});

// ==================== GEMINI AI ====================

const askGemini = async (message) => {
    try {
        console.log(`📤 Запрос к Gemini: "${message.substring(0, 50)}..."`);
        
        if (!GEMINI_API_KEY || GEMINI_API_KEY === 'YOUR_GEMINI_API_KEY') {
            return "🔑 API ключ Gemini не настроен. Получите его на https://makersuite.google.com/app/apikey";
        }
        
        const response = await axios.post(GEMINI_URL, {
            contents: [{
                parts: [{
                    text: `Ты - дружелюбный помощник для студента. Отвечай на русском языке, используй эмодзи. Помогай с учебой, объясняй темы, решай задачи. Отвечай кратко (2-3 предложения), но информативно.\n\nВопрос: ${message}\n\nОтвет:`
                }]
            }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 500
            }
        }, {
            timeout: 30000,
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (response.data && 
            response.data.candidates && 
            response.data.candidates[0] && 
            response.data.candidates[0].content &&
            response.data.candidates[0].content.parts &&
            response.data.candidates[0].content.parts[0]) {
            
            return response.data.candidates[0].content.parts[0].text;
        } else {
            return "😔 Не удалось получить ответ от Gemini";
        }
        
    } catch (error) {
        console.error('❌ Gemini API Error:', error.message);
        botStats.errors.push({
            time: new Date(),
            message: error.message,
            type: 'gemini'
        });
        return "😔 Ошибка при обращении к Gemini. Попробуй позже.";
    }
};

// Команда /ask
bot.onText(/\/ask (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const question = match[1];
    updateStats('/ask');
    
    try {
        bot.sendChatAction(chatId, 'typing');
        const thinking = await bot.sendMessage(chatId, '🤔 Думаю...');
        
        const answer = await askGemini(question);
        
        await bot.deleteMessage(chatId, thinking.message_id);
        bot.sendMessage(chatId, answer, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error('Error in /ask:', error);
        bot.sendMessage(chatId, '❌ Ошибка. Попробуй еще раз.');
    }
});

// Кнопка "Спросить Gemini"
bot.onText(/🤖 Спросить Gemini/, (msg) => {
    const chatId = msg.chat.id;
    updateStats('🤖 Gemini');
    
    bot.sendMessage(
        chatId,
        '💭 Задай вопрос Gemini AI:\n\n' +
        '• По учебе\n• По программированию\n• По математике\n• По физике\n• По английскому',
        {
            reply_markup: {
                force_reply: true
            }
        }
    );
});

// ==================== РАСПИСАНИЕ ====================

bot.onText(/📅 Расписание/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('📅 Расписание');
    
    const weekInfo = await getWeekInfoForUser(userId);
    
    let weekButtons = [];
    if (weekInfo.system === 'two_week') {
        weekButtons = [
            ['📗 Первая неделя', '📕 Вторая неделя']
        ];
    }
    
    const menu = {
        reply_markup: {
            keyboard: [
                ['📅 На сегодня', '📅 На завтра'],
                ...weekButtons,
                ['📅 На неделю', '➕ Добавить пару'],
                ['🔙 Главное меню']
            ],
            resize_keyboard: true
        }
    };
    
    bot.sendMessage(chatId, `📅 *Управление расписанием*\n${weekInfo.systemText}\n${weekInfo.currentText || ''}`, {
        parse_mode: 'Markdown',
        reply_markup: menu.reply_markup
    });
});

// На сегодня
bot.onText(/📅 На сегодня/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('📅 На сегодня');
    
    try {
        const today = new Date().toISOString().split('T')[0];
        const weekInfo = await getWeekInfoForUser(userId);
        
        const lessons = await Lesson.findByDate(userId, today);
        
        if (lessons.length === 0) {
            bot.sendMessage(chatId, `📅 Сегодня пар нет. Отдыхай! 🎉\n\n${weekInfo.currentText || ''}`);
            return;
        }
        
        let message = `📅 *Расписание на сегодня*\n${weekInfo.currentText || ''}\n\n`;
        lessons.sort((a, b) => a.time.localeCompare(b.time));
        lessons.forEach((l, i) => {
            const weekIcon = l.week_type === 'both' ? '📘' : 
                            l.week_type === 'first' ? '📗' : 
                            l.week_type === 'second' ? '📕' : '';
            message += `${i+1}. ${weekIcon} *${l.subject}*\n`;
            message += `   ⏰ ${l.time} | 🏢 ${l.room}\n`;
            message += `   👨‍🏫 ${l.teacher}\n\n`;
        });
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки расписания');
    }
});

// На завтра
bot.onText(/📅 На завтра/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('📅 На завтра');
    
    try {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        const dateStr = tomorrow.toISOString().split('T')[0];
        
        const settings = await getUserWeekSettings(userId);
        let weekTypeText = '';
        
        if (settings.system === 'two_week') {
            const weekType = getWeekTypeForDate(dateStr);
            weekTypeText = formatWeekType(weekType);
        }
        
        const lessons = await Lesson.findByDate(userId, dateStr);
        
        if (lessons.length === 0) {
            bot.sendMessage(chatId, `📅 Завтра пар нет. Можно отдохнуть! 🎉\n\n${weekTypeText}`);
            return;
        }
        
        let message = `📅 *Расписание на завтра*\n${weekTypeText}\n\n`;
        lessons.sort((a, b) => a.time.localeCompare(b.time));
        lessons.forEach((l, i) => {
            const weekIcon = l.week_type === 'both' ? '📘' : 
                            l.week_type === 'first' ? '📗' : 
                            l.week_type === 'second' ? '📕' : '';
            message += `${i+1}. ${weekIcon} *${l.subject}*\n`;
            message += `   ⏰ ${l.time} | 🏢 ${l.room}\n`;
            message += `   👨‍🏫 ${l.teacher}\n\n`;
        });
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки расписания');
    }
});

// Первая неделя
bot.onText(/📗 Первая неделя/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('📗 Первая неделя');
    
    try {
        const lessons = await Lesson.getByWeekType(userId, 'first');
        const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
        
        let message = '📗 *Расписание на первую неделю*\n\n';
        let hasLessons = false;
        
        for (const day of days) {
            const dayLessons = lessons.filter(l => l.day === day);
            if (dayLessons.length > 0) {
                hasLessons = true;
                dayLessons.sort((a, b) => a.time.localeCompare(b.time));
                message += `*${day}:*\n`;
                dayLessons.forEach(l => {
                    const weekIcon = l.week_type === 'both' ? '📘' : '📗';
                    message += `   • ${weekIcon} ${l.time} - ${l.subject} (${l.room})\n`;
                });
                message += '\n';
            }
        }
        
        if (!hasLessons) {
            message += 'Нет пар на первую неделю';
        }
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки расписания');
    }
});

// Вторая неделя
bot.onText(/📕 Вторая неделя/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('📕 Вторая неделя');
    
    try {
        const lessons = await Lesson.getByWeekType(userId, 'second');
        const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
        
        let message = '📕 *Расписание на вторую неделю*\n\n';
        let hasLessons = false;
        
        for (const day of days) {
            const dayLessons = lessons.filter(l => l.day === day);
            if (dayLessons.length > 0) {
                hasLessons = true;
                dayLessons.sort((a, b) => a.time.localeCompare(b.time));
                message += `*${day}:*\n`;
                dayLessons.forEach(l => {
                    const weekIcon = l.week_type === 'both' ? '📘' : '📕';
                    message += `   • ${weekIcon} ${l.time} - ${l.subject} (${l.room})\n`;
                });
                message += '\n';
            }
        }
        
        if (!hasLessons) {
            message += 'Нет пар на вторую неделю';
        }
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки расписания');
    }
});

// На неделю
bot.onText(/📅 На неделю/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('📅 На неделю');
    
    try {
        const lessons = await Lesson.findAll(userId);
        const weekInfo = await getWeekInfoForUser(userId);
        const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
        
        let message = `📅 *Расписание на неделю*\n${weekInfo.systemText}\n`;
        if (weekInfo.currentText) {
            message += `${weekInfo.currentText}\n`;
        }
        message += '\n';
        
        let hasLessons = false;
        
        for (const day of days) {
            const dayLessons = lessons.filter(l => l.day === day);
            if (dayLessons.length > 0) {
                hasLessons = true;
                dayLessons.sort((a, b) => a.time.localeCompare(b.time));
                message += `*${day}:*\n`;
                dayLessons.forEach(l => {
                    const weekIcon = l.week_type === 'both' ? '📘' : 
                                    l.week_type === 'first' ? '📗' : '📕';
                    message += `   • ${weekIcon} ${l.time} - ${l.subject} (${l.room})\n`;
                });
                message += '\n';
            }
        }
        
        if (!hasLessons) {
            message += 'Расписание пусто. Добавьте пары! 📚';
        }
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки расписания');
    }
});

// Добавить пару
bot.onText(/➕ Добавить пару/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('➕ Добавить пару');
    
    const settings = await getUserWeekSettings(userId);
    
    if (settings.system === 'one_week') {
        // Для однонедельной системы не спрашиваем тип
        bot.lessonWeekType = 'both';
        bot.sendMessage(chatId, 
            `✏️ *Добавление новой пары* (📘 Каждую неделю)\n\n` +
            'Введите данные в формате:\n' +
            '`Предмет, Дата (ГГГГ-ММ-ДД), Время, Аудитория, Преподаватель`\n\n' +
            'Пример: `Математика, 2024-12-16, 10:00, 301, Иванов И.И.`',
            { parse_mode: 'Markdown' }
        );
    } else {
        // Для двухнедельной системы спрашиваем тип
        const weekTypeKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📘 Каждую неделю', callback_data: 'lesson_week_both' }],
                    [{ text: '📗 Первая неделя', callback_data: 'lesson_week_first' }],
                    [{ text: '📕 Вторая неделя', callback_data: 'lesson_week_second' }]
                ]
            }
        };
        
        bot.sendMessage(chatId, 
            '📅 *Выберите тип недели для пары:*', 
            { 
                parse_mode: 'Markdown',
                reply_markup: weekTypeKeyboard.reply_markup 
            }
        );
        
        bot.lessonWeekType = null;
    }
});

// Обработка выбора типа недели для пары
bot.on('callback_query', async (callbackQuery) => {
    if (!callbackQuery.data.startsWith('lesson_week_')) return;
    
    const chatId = callbackQuery.message.chat.id;
    const weekType = callbackQuery.data.replace('lesson_week_', '');
    
    bot.answerCallbackQuery(callbackQuery.id);
    bot.lessonWeekType = weekType;
    
    const weekTypeText = {
        'both': '📘 Каждую неделю',
        'first': '📗 Первая неделя',
        'second': '📕 Вторая неделя'
    }[weekType];
    
    bot.sendMessage(chatId, 
        `✏️ *Добавление новой пары* (${weekTypeText})\n\n` +
        'Введите данные в формате:\n' +
        '`Предмет, Дата (ГГГГ-ММ-ДД), Время, Аудитория, Преподаватель`\n\n' +
        'Пример: `Математика, 2024-12-16, 10:00, 301, Иванов И.И.`\n\n' +
        '💡 *Подсказка:* Если пара повторяется каждую неделю, дата не важна, можно указать любую.',
        { parse_mode: 'Markdown' }
    );
    
    bot.once('message', async (answer) => {
        const userId = answer.from.id.toString();
        const parts = answer.text.split(',').map(p => p.trim());
        
        if (parts.length === 5) {
            const [subject, date, time, room, teacher] = parts;
            
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                bot.sendMessage(chatId, '❌ Неверный формат даты. Используйте ГГГГ-ММ-ДД');
                return;
            }
            
            try {
                const lessonDate = new Date(date);
                const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
                const day = days[lessonDate.getDay()];
                
                await Lesson.create({
                    user_id: userId,
                    date,
                    day,
                    time,
                    subject,
                    room,
                    teacher,
                    week_type: bot.lessonWeekType || 'both'
                });
                
                await User.addExperience(userId, 10);
                
                const groups = await Group.getUserGroups(userId);
                for (const group of groups) {
                    await Group.addPoints(group.id, userId, 5, 'lesson_added');
                }
                
                const weekTypeEmoji = bot.lessonWeekType === 'both' ? '📘' : 
                                     bot.lessonWeekType === 'first' ? '📗' : '📕';
                
                bot.sendMessage(chatId, `✅ Пара успешно добавлена! ${weekTypeEmoji}`);
                bot.lessonWeekType = null;
            } catch (error) {
                console.error(error);
                bot.sendMessage(chatId, '❌ Ошибка сохранения');
            }
        } else {
            bot.sendMessage(chatId, '❌ Неверный формат. Нужно 5 полей через запятую');
        }
    });
});

// ==================== ДЕДЛАЙНЫ ====================

bot.onText(/📝 Дедлайны/, (msg) => {
    const chatId = msg.chat.id;
    updateStats('📝 Дедлайны');
    
    const menu = {
        reply_markup: {
            keyboard: [
                ['📝 Активные', '✅ Выполненные'],
                ['📅 Ближайшие (7 дней)', '➕ Добавить дедлайн'],
                ['🔙 Главное меню']
            ],
            resize_keyboard: true
        }
    };
    
    bot.sendMessage(chatId, '📝 *Управление дедлайнами*', {
        parse_mode: 'Markdown',
        reply_markup: menu.reply_markup
    });
});

// Активные дедлайны
bot.onText(/📝 Активные/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('📝 Активные');
    
    try {
        const deadlines = await Deadline.findAll(userId, false);
        
        if (deadlines.length === 0) {
            bot.sendMessage(chatId, '📝 Активных дедлайнов нет! 🎉');
            return;
        }
        
        deadlines.sort((a, b) => new Date(a.date) - new Date(b.date));
        
        let message = '📝 *Активные дедлайны:*\n\n';
        deadlines.forEach((d, i) => {
            const days = Math.ceil((new Date(d.date) - new Date()) / (1000 * 60 * 60 * 24));
            const emoji = d.priority === 'high' ? '🔴' : d.priority === 'medium' ? '🟡' : '🟢';
            const daysText = days < 0 ? '🔥 Просрочено' : 
                           days === 0 ? '🚨 Сегодня' : 
                           days === 1 ? '⏰ Завтра' : 
                           `⏰ ${days} дн.`;
            
            message += `${i+1}. ${emoji} *${d.subject}*\n`;
            message += `   📌 ${d.task}\n`;
            message += `   📅 ${new Date(d.date).toLocaleDateString('ru-RU')} (${daysText})\n\n`;
        });
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки дедлайнов');
    }
});

// Выполненные дедлайны
bot.onText(/✅ Выполненные/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('✅ Выполненные');
    
    try {
        const deadlines = await Deadline.findAll(userId, true);
        
        if (deadlines.length === 0) {
            bot.sendMessage(chatId, '✅ Выполненных дедлайнов пока нет');
            return;
        }
        
        let message = '✅ *Выполненные дедлайны:*\n\n';
        deadlines.slice(0, 10).forEach((d, i) => {
            message += `${i+1}. *${d.subject}* - ${d.task}\n`;
            message += `   ✅ ${new Date(d.completed_at || d.created_at).toLocaleDateString('ru-RU')}\n\n`;
        });
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки');
    }
});

// Ближайшие дедлайны
bot.onText(/📅 Ближайшие \(7 дней\)/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('📅 Ближайшие');
    
    try {
        const deadlines = await Deadline.getUpcoming(userId, 7);
        
        if (deadlines.length === 0) {
            bot.sendMessage(chatId, '📅 В ближайшие 7 дней дедлайнов нет! 🎉');
            return;
        }
        
        let message = '📅 *Дедлайны на 7 дней:*\n\n';
        deadlines.forEach((d, i) => {
            const days = Math.ceil((new Date(d.date) - new Date()) / (1000 * 60 * 60 * 24));
            const emoji = d.priority === 'high' ? '🔴' : d.priority === 'medium' ? '🟡' : '🟢';
            
            message += `${i+1}. ${emoji} *${d.subject}*\n`;
            message += `   📌 ${d.task}\n`;
            message += `   📅 ${new Date(d.date).toLocaleDateString('ru-RU')} (${days} дн.)\n\n`;
        });
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки');
    }
});

// Добавить дедлайн
bot.onText(/➕ Добавить дедлайн/, (msg) => {
    const chatId = msg.chat.id;
    updateStats('➕ Добавить дедлайн');
    
    bot.sendMessage(chatId,
        '✏️ *Добавление дедлайна*\n\n' +
        'Введите данные в формате:\n' +
        '`Предмет, Задача, Дата (ГГГГ-ММ-ДД), Приоритет (high/medium/low)`\n\n' +
        'Пример: `Математика, Курсовая, 2024-12-25, high`',
        { parse_mode: 'Markdown' }
    );
    
    bot.once('message', async (answer) => {
        const userId = answer.from.id.toString();
        const parts = answer.text.split(',').map(p => p.trim());
        
        if (parts.length === 4) {
            const [subject, task, date, priority] = parts;
            
            if (!['high', 'medium', 'low'].includes(priority)) {
                bot.sendMessage(chatId, '❌ Приоритет должен быть: high, medium или low');
                return;
            }
            
            try {
                await Deadline.create({
                    user_id: userId,
                    subject,
                    task,
                    date,
                    priority
                });
                
                await User.addExperience(userId, 15);
                
                const groups = await Group.getUserGroups(userId);
                for (const group of groups) {
                    await Group.addPoints(group.id, userId, 10, 'deadline_added');
                }
                
                bot.sendMessage(chatId, '✅ Дедлайн добавлен!');
            } catch (error) {
                console.error(error);
                bot.sendMessage(chatId, '❌ Ошибка сохранения');
            }
        } else {
            bot.sendMessage(chatId, '❌ Неверный формат. Нужно 4 поля через запятую');
        }
    });
});

// ==================== ЗАМЕТКИ ====================

bot.onText(/📒 Заметки/, (msg) => {
    const chatId = msg.chat.id;
    updateStats('📒 Заметки');
    
    const menu = {
        reply_markup: {
            keyboard: [
                ['📒 Все заметки', '➕ Создать заметку'],
                ['🔍 Поиск', '🔙 Главное меню']
            ],
            resize_keyboard: true
        }
    };
    
    bot.sendMessage(chatId, '📒 *Управление заметками*', {
        parse_mode: 'Markdown',
        reply_markup: menu.reply_markup
    });
});

// Все заметки
bot.onText(/📒 Все заметки/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('📒 Все заметки');
    
    try {
        const notes = await Note.findAll(userId);
        
        if (notes.length === 0) {
            bot.sendMessage(chatId, '📒 У вас пока нет заметок');
            return;
        }
        
        let message = '📒 *Ваши заметки:*\n\n';
        notes.slice(0, 10).forEach((n, i) => {
            message += `${i+1}. *${n.title}*\n`;
            message += `   📝 ${n.preview || n.content.substring(0, 50)}...\n`;
            message += `   📅 ${new Date(n.created_at).toLocaleDateString('ru-RU')}\n\n`;
        });
        
        if (notes.length > 10) {
            message += `*...и ещё ${notes.length - 10} заметок*`;
        }
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки');
    }
});

// Создать заметку
bot.onText(/➕ Создать заметку/, (msg) => {
    const chatId = msg.chat.id;
    updateStats('➕ Создать заметку');
    
    bot.sendMessage(chatId, '✏️ *Создание заметки*\n\nВведите заголовок:');
    
    bot.once('message', (titleMsg) => {
        const title = titleMsg.text;
        
        bot.sendMessage(chatId, '📝 Введите содержание заметки:');
        
        bot.once('message', async (contentMsg) => {
            const userId = contentMsg.from.id.toString();
            const content = contentMsg.text;
            const preview = content.substring(0, 50) + (content.length > 50 ? '...' : '');
            
            try {
                await Note.create({
                    user_id: userId,
                    title,
                    content,
                    preview
                });
                
                await User.addExperience(userId, 5);
                
                const groups = await Group.getUserGroups(userId);
                for (const group of groups) {
                    await Group.addPoints(group.id, userId, 3, 'note_added');
                }
                
                bot.sendMessage(chatId, '✅ Заметка создана!');
            } catch (error) {
                console.error(error);
                bot.sendMessage(chatId, '❌ Ошибка сохранения');
            }
        });
    });
});

// Поиск заметок
bot.onText(/🔍 Поиск/, (msg) => {
    const chatId = msg.chat.id;
    updateStats('🔍 Поиск');
    
    bot.sendMessage(chatId, '🔍 Введите текст для поиска в заметках:');
    
    bot.once('message', async (searchMsg) => {
        const userId = searchMsg.from.id.toString();
        const query = searchMsg.text;
        
        try {
            const results = await Note.search(userId, query);
            
            if (results.length === 0) {
                bot.sendMessage(chatId, '🔍 Ничего не найдено');
                return;
            }
            
            let message = `🔍 *Найдено: ${results.length}*\n\n`;
            results.forEach((n, i) => {
                message += `${i+1}. *${n.title}*\n`;
                message += `   📝 ${n.preview}\n\n`;
            });
            
            bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, '❌ Ошибка поиска');
        }
    });
});

// ==================== ГРУППЫ ====================

bot.onText(/👥 Группы/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('👥 Группы');
    
    try {
        const groups = await Group.getUserGroups(userId);
        
        let message = '👥 *Мои группы*\n\n';
        
        if (groups.length === 0) {
            message += 'У вас пока нет групп. Создайте или присоединитесь!';
        } else {
            groups.forEach(g => {
                const roleEmoji = g.role === 'owner' ? '👑' : g.role === 'admin' ? '⭐' : '👤';
                message += `${roleEmoji} *${g.name}*\n`;
                message += `   Очков: ${g.points}\n`;
                message += `   Код: \`${g.invite_code}\`\n\n`;
            });
        }
        
        const groupMenu = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '➕ Создать группу', callback_data: 'group_create' }],
                    [{ text: '🔑 Присоединиться по коду', callback_data: 'group_join' }],
                    ...(groups.length > 0 ? [[{ text: '📊 Мои группы', callback_data: 'group_list' }]] : [])
                ]
            }
        };
        
        bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: groupMenu.reply_markup
        });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки групп');
    }
});

// Создание группы
bot.on('callback_query', async (callbackQuery) => {
    if (callbackQuery.data !== 'group_create') return;
    
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id.toString();
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    bot.sendMessage(chatId, '📝 Введите название новой группы:');
    
    bot.once('message', async (msg) => {
        const groupName = msg.text;
        
        try {
            const group = await Group.create(groupName, userId);
            
            await Group.addPoints(group.id, userId, 100, 'group_created');
            
            const successMessage = 
                `✅ Группа *${groupName}* успешно создана!\n\n` +
                `🔑 *Код приглашения:* \`${group.inviteCode}\`\n\n` +
                `Поделитесь этим кодом с одногруппниками, чтобы они могли присоединиться.\n\n` +
                `👑 Вы стали старостой группы!`;
            
            const groupActions = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📊 Турнирная таблица', callback_data: `group_leaderboard_${group.id}` }],
                        [{ text: '📅 Расписание группы', callback_data: `group_schedule_${group.id}` }],
                        [{ text: '👥 Участники', callback_data: `group_members_${group.id}` }]
                    ]
                }
            };
            
            bot.sendMessage(chatId, successMessage, {
                parse_mode: 'Markdown',
                reply_markup: groupActions.reply_markup
            });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Ошибка при создании группы: ' + error.message);
        }
    });
});

// Присоединение к группе
bot.on('callback_query', async (callbackQuery) => {
    if (callbackQuery.data !== 'group_join') return;
    
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id.toString();
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    bot.sendMessage(chatId, '🔑 Введите код приглашения:');
    
    bot.once('message', async (msg) => {
        const inviteCode = msg.text.trim().toUpperCase();
        
        try {
            const group = await Group.findByInviteCode(inviteCode);
            
            if (!group) {
                bot.sendMessage(chatId, '❌ Группа с таким кодом не найдена');
                return;
            }
            
            await Group.join(inviteCode, userId);
            
            await Group.addPoints(group.id, userId, 10, 'joined_group');
            
            const successMessage = 
                `✅ Вы присоединились к группе *${group.name}*!\n\n` +
                `👥 Теперь вы можете видеть расписание и дедлайны группы.\n` +
                `🏆 Участвуйте в жизни группы и зарабатывайте очки!`;
            
            const groupActions = {
                reply_markup: {
                    inline_keyboard: [
                        [{ text: '📊 Турнирная таблица', callback_data: `group_leaderboard_${group.id}` }],
                        [{ text: '📅 Расписание группы', callback_data: `group_schedule_${group.id}` }],
                        [{ text: '👥 Участники', callback_data: `group_members_${group.id}` }]
                    ]
                }
            };
            
            bot.sendMessage(chatId, successMessage, {
                parse_mode: 'Markdown',
                reply_markup: groupActions.reply_markup
            });
        } catch (error) {
            bot.sendMessage(chatId, '❌ Ошибка: ' + error.message);
        }
    });
});

// Турнирная таблица
bot.on('callback_query', async (callbackQuery) => {
    if (!callbackQuery.data.startsWith('group_leaderboard_')) return;
    
    const chatId = callbackQuery.message.chat.id;
    const groupId = callbackQuery.data.replace('group_leaderboard_', '');
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    try {
        const group = await Group.findById(groupId);
        const leaderboard = await Group.getLeaderboard(groupId, 15);
        
        let message = `🏆 *Турнирная таблица группы ${group.name}*\n\n`;
        
        if (leaderboard.length === 0) {
            message += 'Пока нет участников';
        } else {
            leaderboard.forEach((member, index) => {
                const medal = index === 0 ? '🥇' : index === 1 ? '🥈' : index === 2 ? '🥉' : '👤';
                const roleEmoji = member.role === 'owner' ? '👑' : member.role === 'admin' ? '⭐' : '';
                message += `${medal} ${index+1}. *${member.name}* ${roleEmoji}\n`;
                message += `   ⭐ Очки: ${member.points}\n\n`;
            });
        }
        
        const backButton = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Назад к группе', callback_data: `group_menu_${groupId}` }]
                ]
            }
        };
        
        bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: backButton.reply_markup
        });
    } catch (error) {
        bot.sendMessage(chatId, '❌ Ошибка загрузки турнирной таблицы');
    }
});

// Расписание группы
bot.on('callback_query', async (callbackQuery) => {
    if (!callbackQuery.data.startsWith('group_schedule_')) return;
    
    const chatId = callbackQuery.message.chat.id;
    const groupId = callbackQuery.data.replace('group_schedule_', '');
    const userId = callbackQuery.from.id.toString();
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    try {
        const group = await Group.findById(groupId);
        const userRole = await Group.getUserRole(groupId, userId);
        const weekInfo = await getWeekInfoForUser(userId);
        
        const today = new Date().toISOString().split('T')[0];
        const lessons = await Group.getGroupLessons(groupId, today);
        
        let message = `📅 *Расписание группы ${group.name}*\n${weekInfo.systemText}\n`;
        if (weekInfo.currentText) {
            message += `${weekInfo.currentText}\n`;
        }
        message += '\n';
        
        if (lessons.length === 0) {
            message += 'Сегодня пар нет 🎉';
        } else {
            lessons.sort((a, b) => a.time.localeCompare(b.time));
            lessons.forEach((l, i) => {
                const weekIcon = l.week_type === 'both' ? '📘' : 
                                l.week_type === 'first' ? '📗' : '📕';
                message += `${i+1}. ${weekIcon} *${l.subject}*\n`;
                message += `   ⏰ ${l.time} | 🏢 ${l.room}\n`;
                message += `   👨‍🏫 ${l.teacher}\n\n`;
            });
        }
        
        const buttons = [];
        if (weekInfo.system === 'two_week') {
            buttons.push(
                [{ text: '📗 Первая неделя', callback_data: `group_schedule_week_${groupId}_first` }],
                [{ text: '📕 Вторая неделя', callback_data: `group_schedule_week_${groupId}_second` }]
            );
        }
        buttons.push([{ text: '📅 На неделю', callback_data: `group_schedule_week_${groupId}_both` }]);
        
        if (userRole === 'owner' || userRole === 'admin') {
            buttons.push([{ text: '➕ Добавить пару', callback_data: `group_add_lesson_${groupId}` }]);
        }
        
        buttons.push([{ text: '🔙 Назад', callback_data: `group_menu_${groupId}` }]);
        
        bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (error) {
        bot.sendMessage(chatId, '❌ Ошибка загрузки расписания');
    }
});

// Расписание группы по неделям
bot.on('callback_query', async (callbackQuery) => {
    if (!callbackQuery.data.startsWith('group_schedule_week_')) return;
    
    const parts = callbackQuery.data.split('_');
    const groupId = parts[3];
    const weekType = parts[4];
    const chatId = callbackQuery.message.chat.id;
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    try {
        const group = await Group.findById(groupId);
        const weekTypeText = weekType === 'both' ? '📅 Вся неделя' : 
                            weekType === 'first' ? '📗 Первая неделя' : '📕 Вторая неделя';
        const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
        
        let lessons;
        if (weekType === 'both') {
            lessons = await Group.getGroupLessons(groupId);
        } else {
            lessons = await Group.getGroupWeekSchedule(groupId, weekType);
        }
        
        let message = `📅 *Расписание группы ${group.name}*\n${weekTypeText}\n\n`;
        let hasLessons = false;
        
        for (const day of days) {
            const dayLessons = lessons.filter(l => l.day === day);
            if (dayLessons.length > 0) {
                hasLessons = true;
                dayLessons.sort((a, b) => a.time.localeCompare(b.time));
                message += `*${day}:*\n`;
                dayLessons.forEach(l => {
                    const weekIcon = l.week_type === 'both' ? '📘' : 
                                    l.week_type === 'first' ? '📗' : '📕';
                    message += `   • ${weekIcon} ${l.time} - ${l.subject} (${l.room})\n`;
                });
                message += '\n';
            }
        }
        
        if (!hasLessons) {
            message += 'Нет пар на этой неделе';
        }
        
        const backButton = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Назад', callback_data: `group_schedule_${groupId}` }]
                ]
            }
        };
        
        bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: backButton.reply_markup
        });
    } catch (error) {
        bot.sendMessage(chatId, '❌ Ошибка загрузки расписания');
    }
});

// Добавление пары в группу
bot.on('callback_query', async (callbackQuery) => {
    if (!callbackQuery.data.startsWith('group_add_lesson_')) return;
    
    const chatId = callbackQuery.message.chat.id;
    const groupId = callbackQuery.data.replace('group_add_lesson_', '');
    const userId = callbackQuery.from.id.toString();
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    const role = await Group.getUserRole(groupId, userId);
    if (role !== 'owner' && role !== 'admin') {
        bot.sendMessage(chatId, '⛔ Только староста и админы могут добавлять пары');
        return;
    }
    
    const settings = await getUserWeekSettings(userId);
    
    if (settings.system === 'one_week') {
        bot.groupLessonWeekType = 'both';
        bot.sendMessage(chatId, 
            `✏️ *Добавление пары в группу* (📘 Каждую неделю)\n\n` +
            'Введите данные в формате:\n' +
            '`Предмет, Дата (ГГГГ-ММ-ДД), Время, Аудитория, Преподаватель`\n\n' +
            'Пример: `Математика, 2024-12-16, 10:00, 301, Иванов И.И.`',
            { parse_mode: 'Markdown' }
        );
    } else {
        const weekTypeKeyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '📘 Каждую неделю', callback_data: `group_lesson_week_${groupId}_both` }],
                    [{ text: '📗 Первая неделя', callback_data: `group_lesson_week_${groupId}_first` }],
                    [{ text: '📕 Вторая неделя', callback_data: `group_lesson_week_${groupId}_second` }]
                ]
            }
        };
        
        bot.sendMessage(chatId, 
            '📅 *Выберите тип недели для пары:*', 
            { 
                parse_mode: 'Markdown',
                reply_markup: weekTypeKeyboard.reply_markup 
            }
        );
    }
});

// Обработка выбора типа недели для групповой пары
bot.on('callback_query', async (callbackQuery) => {
    if (!callbackQuery.data.startsWith('group_lesson_week_')) return;
    
    const parts = callbackQuery.data.split('_');
    const groupId = parts[3];
    const weekType = parts[4];
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id.toString();
    
    bot.answerCallbackQuery(callbackQuery.id);
    bot.groupLessonWeekType = weekType;
    
    const weekTypeText = {
        'both': '📘 Каждую неделю',
        'first': '📗 Первая неделя',
        'second': '📕 Вторая неделя'
    }[weekType];
    
    bot.sendMessage(chatId, 
        `✏️ *Добавление пары в группу* (${weekTypeText})\n\n` +
        'Введите данные в формате:\n' +
        '`Предмет, Дата (ГГГГ-ММ-ДД), Время, Аудитория, Преподаватель`\n\n' +
        'Пример: `Математика, 2024-12-16, 10:00, 301, Иванов И.И.`',
        { parse_mode: 'Markdown' }
    );
    
    bot.once('message', async (msg) => {
        const parts = msg.text.split(',').map(p => p.trim());
        
        if (parts.length === 5) {
            const [subject, date, time, room, teacher] = parts;
            
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                bot.sendMessage(chatId, '❌ Неверный формат даты');
                return;
            }
            
            try {
                const lessonDate = new Date(date);
                const days = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];
                const day = days[lessonDate.getDay()];
                
                await Group.addGroupLesson(groupId, {
                    date, day, time, subject, room, teacher, week_type: bot.groupLessonWeekType || 'both'
                }, userId);
                
                await Group.addPoints(groupId, userId, 10, 'group_lesson_added');
                
                bot.sendMessage(chatId, '✅ Пара добавлена в расписание группы!');
                bot.groupLessonWeekType = null;
            } catch (error) {
                bot.sendMessage(chatId, '❌ Ошибка: ' + error.message);
            }
        } else {
            bot.sendMessage(chatId, '❌ Неверный формат');
        }
    });
});

// Список участников группы
bot.on('callback_query', async (callbackQuery) => {
    if (!callbackQuery.data.startsWith('group_members_')) return;
    
    const chatId = callbackQuery.message.chat.id;
    const groupId = callbackQuery.data.replace('group_members_', '');
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    try {
        const group = await Group.findById(groupId);
        const members = await Group.getMembers(groupId);
        
        let message = `👥 *Участники группы ${group.name}*\n\n`;
        
        members.forEach(m => {
            const roleEmoji = m.role === 'owner' ? '👑 Староста' : m.role === 'admin' ? '⭐ Админ' : '👤 Участник';
            message += `• *${m.name}* ${roleEmoji}\n`;
            message += `  ⭐ Очки: ${m.points} | Уровень: ${m.level}\n\n`;
        });
        
        const backButton = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🔙 Назад', callback_data: `group_menu_${groupId}` }]
                ]
            }
        };
        
        bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: backButton.reply_markup
        });
    } catch (error) {
        bot.sendMessage(chatId, '❌ Ошибка загрузки участников');
    }
});

// Меню группы
bot.on('callback_query', async (callbackQuery) => {
    if (!callbackQuery.data.startsWith('group_menu_')) return;
    
    const chatId = callbackQuery.message.chat.id;
    const groupId = callbackQuery.data.replace('group_menu_', '');
    const userId = callbackQuery.from.id.toString();
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    try {
        const group = await Group.findById(groupId);
        const userRole = await Group.getUserRole(groupId, userId);
        
        const buttons = [
            [{ text: '🏆 Турнирная таблица', callback_data: `group_leaderboard_${groupId}` }],
            [{ text: '📅 Расписание', callback_data: `group_schedule_${groupId}` }],
            [{ text: '👥 Участники', callback_data: `group_members_${groupId}` }]
        ];
        
        if (userRole === 'owner') {
            buttons.push([{ text: '⚙️ Управление группой', callback_data: `group_admin_${groupId}` }]);
        }
        
        buttons.push([{ text: '🔙 К списку групп', callback_data: 'group_list' }]);
        
        bot.sendMessage(chatId, `👥 *Группа: ${group.name}*`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (error) {
        bot.sendMessage(chatId, '❌ Ошибка загрузки группы');
    }
});

// Список групп пользователя
bot.on('callback_query', async (callbackQuery) => {
    if (callbackQuery.data !== 'group_list') return;
    
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id.toString();
    
    bot.answerCallbackQuery(callbackQuery.id);
    
    try {
        const groups = await Group.getUserGroups(userId);
        
        if (groups.length === 0) {
            bot.sendMessage(chatId, '👥 У вас пока нет групп');
            return;
        }
        
        let message = '👥 *Ваши группы*\n\n';
        const buttons = [];
        
        groups.forEach(g => {
            const roleEmoji = g.role === 'owner' ? '👑' : g.role === 'admin' ? '⭐' : '👤';
            message += `${roleEmoji} *${g.name}*\n`;
            message += `   Очков: ${g.points}\n\n`;
            buttons.push([{ text: `📌 ${g.name}`, callback_data: `group_menu_${g.id}` }]);
        });
        
        buttons.push([{ text: '🔙 Назад', callback_data: 'back_to_groups' }]);
        
        bot.sendMessage(chatId, message, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: buttons }
        });
    } catch (error) {
        bot.sendMessage(chatId, '❌ Ошибка загрузки групп');
    }
});

// Возврат в меню групп
bot.on('callback_query', async (callbackQuery) => {
    if (callbackQuery.data !== 'back_to_groups') return;
    
    const chatId = callbackQuery.message.chat.id;
    const userId = callbackQuery.from.id.toString();
    
    bot.answerCallbackQuery(callbackQuery.id);
    bot.emit('text', { chat: { id: chatId }, from: { id: userId }, text: '👥 Группы' });
});

// ==================== ПРОФИЛЬ И НАСТРОЙКИ ====================

bot.onText(/⚙️ Настройки/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('⚙️ Настройки');
    
    try {
        const user = await User.findByPk(userId);
        let settings = {};
        if (user && user.settings) {
            settings = typeof user.settings === 'string' ? JSON.parse(user.settings) : user.settings;
        }
        
        const menu = {
            reply_markup: {
                keyboard: [
                    ['👤 Профиль', '🏛️ Мой университет'],
                    ['📝 Изменить группу', `🔔 Уведомления: ${settings.notifications ? '✅' : '❌'}`],
                    ['📊 Статистика', '🗑 Очистить данные'],
                    ['🔙 Главное меню']
                ],
                resize_keyboard: true
            }
        };
        
        bot.sendMessage(chatId, '⚙️ *Настройки профиля*', {
            parse_mode: 'Markdown',
            reply_markup: menu.reply_markup
        });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки настроек');
    }
});

// Профиль
bot.onText(/👤 Профиль/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('👤 Профиль');
    
    try {
        const user = await User.findByPk(userId);
        const lessons = await Lesson.findAll(userId);
        const deadlines = await Deadline.findAll(userId);
        const notes = await Note.findAll(userId);
        const groups = await Group.getUserGroups(userId);
        const settings = await getUserWeekSettings(userId);
        const university = await getUserUniversity(userId);
        
        const daysActive = Math.ceil((new Date() - new Date(user.registered_at)) / (1000 * 60 * 60 * 24));
        
        const weekSystemText = settings.system === 'one_week' ? '📅 Однонедельная' : '🔄 Двухнедельная';
        
        const message = 
            `👤 *Профиль*\n\n` +
            `Имя: ${user.name}\n` +
            `Группа: ${user.group_name || 'Не указана'}\n` +
            (university ? `🏛️ Университет: *${university.name}*\n` : '') +
            `Система недель: ${weekSystemText}\n` +
            `С нами: ${daysActive} дней\n` +
            `Уровень: ${user.level || 1}\n` +
            `Опыт: ${user.experience || 0}\n\n` +
            `📊 *Статистика*\n` +
            `📅 Пар: ${lessons.length}\n` +
            `📝 Дедлайнов: ${deadlines.length}\n` +
            `📒 Заметок: ${notes.length}\n` +
            `👥 Групп: ${groups.length}`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки профиля');
    }
});

// Мой университет
bot.onText(/🏛️ Мой университет/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('🏛️ Мой университет');
    
    const university = await getUserUniversity(userId);
    
    if (!university) {
        const keyboard = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: '🎓 Выбрать университет', callback_data: 'change_uni_confirm' }]
                ]
            }
        };
        
        bot.sendMessage(chatId, 
            '❌ У вас не выбран университет.\n\n' +
            'Нажмите кнопку ниже, чтобы выбрать!',
            keyboard
        );
        return;
    }
    
    const message = 
        `🏛️ *Мой университет*\n\n` +
        `*${university.name}*\n` +
        `📍 ${university.city}\n` +
        `⭐ Рейтинг: ${university.point}\n` +
        `🔗 [Сайт университета](${university.url})`;
    
    const keyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '🔄 Сменить университет', callback_data: 'change_uni_confirm' }]
            ]
        }
    };
    
    bot.sendMessage(chatId, message, {
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
        reply_markup: keyboard.reply_markup
    });
});

// Изменить группу
bot.onText(/📝 Изменить группу/, (msg) => {
    const chatId = msg.chat.id;
    updateStats('📝 Изменить группу');
    
    bot.sendMessage(chatId, '📝 Введите вашу новую группу:');
    
    bot.once('message', async (answer) => {
        const userId = answer.from.id.toString();
        const newGroup = answer.text;
        
        try {
            await User.update(userId, { group_name: newGroup });
            bot.sendMessage(chatId, `✅ Группа изменена на: ${newGroup}`);
        } catch (error) {
            console.error(error);
            bot.sendMessage(chatId, '❌ Ошибка сохранения');
        }
    });
});

// Переключение уведомлений
bot.onText(/🔔 Уведомления:/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('🔔 Уведомления');
    
    try {
        const user = await User.findByPk(userId);
        let settings = {};
        if (user && user.settings) {
            settings = typeof user.settings === 'string' ? JSON.parse(user.settings) : user.settings;
        }
        
        settings.notifications = !settings.notifications;
        
        await User.update(userId, { settings: JSON.stringify(settings) });
        
        bot.sendMessage(chatId, `✅ Уведомления ${settings.notifications ? 'включены' : 'выключены'}`);
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка');
    }
});

// Статистика пользователя
bot.onText(/📊 Статистика/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('📊 Статистика');
    
    try {
        const user = await User.findByPk(userId);
        const lessons = await Lesson.findAll(userId);
        const deadlines = await Deadline.findAll(userId);
        const notes = await Note.findAll(userId);
        
        const completedDeadlines = deadlines.filter(d => d.completed).length;
        const activeDeadlines = deadlines.length - completedDeadlines;
        
        const message = 
            `📊 *Ваша статистика*\n\n` +
            `📅 Всего пар: ${lessons.length}\n` +
            `📝 Всего дедлайнов: ${deadlines.length}\n` +
            `   ✅ Выполнено: ${completedDeadlines}\n` +
            `   ⏳ Осталось: ${activeDeadlines}\n` +
            `📒 Всего заметок: ${notes.length}\n\n` +
            `🏆 Уровень: ${user.level || 1}\n` +
            `⭐️ Опыт: ${user.experience || 0}`;
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки статистики');
    }
});

// Очистить данные
bot.onText(/🗑 Очистить данные/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('🗑 Очистить данные');
    
    bot.sendMessage(chatId, '⚠️ *Внимание!*\nЭто удалит ВСЕ ваши данные: расписание, дедлайны, заметки.\n\nВы уверены? (да/нет)', {
        parse_mode: 'Markdown'
    });
    
    bot.once('message', async (answer) => {
        if (answer.text.toLowerCase() === 'да') {
            try {
                db.run('DELETE FROM lessons WHERE user_id = ?', [userId]);
                db.run('DELETE FROM deadlines WHERE user_id = ?', [userId]);
                db.run('DELETE FROM notes WHERE user_id = ?', [userId]);
                
                db.run('UPDATE group_members SET points = 0 WHERE user_id = ?', [userId]);
                
                await User.update(userId, { 
                    experience: 0, 
                    level: 1,
                    group_name: 'Не указана'
                });
                
                bot.sendMessage(chatId, '✅ Все данные успешно очищены!');
            } catch (error) {
                console.error(error);
                bot.sendMessage(chatId, '❌ Ошибка при очистке');
            }
        } else {
            bot.sendMessage(chatId, '❌ Операция отменена');
        }
    });
});

// ==================== АВТОМАТИЧЕСКИЕ ФУНКЦИИ ====================

const morningReminders = async () => {
    try {
        const users = await new Promise((resolve, reject) => {
            db.all('SELECT user_id, settings FROM users', [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
        
        for (const user of users) {
            let settings;
            try {
                settings = JSON.parse(user.settings);
            } catch {
                settings = { notifications: true };
            }
            
            if (settings.notifications) {
                const userId = user.user_id;
                const today = new Date().toISOString().split('T')[0];
                const dayName = new Date().toLocaleDateString('ru-RU', { weekday: 'long' });
                
                const weekInfo = await getWeekInfoForUser(userId);
                const lessons = await Lesson.findByDay(userId, dayName);
                const deadlines = await Deadline.getUpcoming(userId, 7);
                
                if (lessons.length > 0 || deadlines.length > 0) {
                    let message = `🌅 *Доброе утро!*\n${weekInfo.systemText}\n`;
                    if (weekInfo.currentText) {
                        message += `${weekInfo.currentText}\n\n`;
                    }
                    
                    if (lessons.length > 0) {
                        message += `📅 *Пары сегодня:*\n`;
                        lessons.sort((a, b) => a.time.localeCompare(b.time));
                        lessons.forEach(l => {
                            const weekIcon = l.week_type === 'both' ? '📘' : 
                                            l.week_type === 'first' ? '📗' : '📕';
                            message += `${weekIcon} ${l.subject} в ${l.time} (${l.room})\n`;
                        });
                    }
                    
                    if (deadlines.length > 0) {
                        if (lessons.length > 0) message += `\n`;
                        message += `📝 *Ближайшие дедлайны:*\n`;
                        deadlines.slice(0, 3).forEach(d => {
                            const days = Math.ceil((new Date(d.date) - new Date()) / (1000 * 60 * 60 * 24));
                            const emoji = d.priority === 'high' ? '🔴' : d.priority === 'medium' ? '🟡' : '🟢';
                            message += `${emoji} ${d.subject}: ${d.task} (${days} дн.)\n`;
                        });
                    }
                    
                    bot.sendMessage(userId, message, { parse_mode: 'Markdown' }).catch(() => {});
                }
            }
        }
    } catch (error) {
        console.error('Error in morningReminders:', error);
        botStats.errors.push({
            time: new Date(),
            message: error.message,
            type: 'reminder'
        });
    }
};

const checkDeadlines = async () => {
    try {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        
        const deadlines = await new Promise((resolve, reject) => {
            db.all('SELECT * FROM deadlines WHERE completed = 0', [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
        
        for (const deadline of deadlines) {
            const userId = deadline.user_id;
            
            const user = await User.findByPk(userId);
            let settings;
            try {
                settings = user?.settings ? JSON.parse(user.settings) : { notifications: true };
            } catch {
                settings = { notifications: true };
            }
            
            if (settings?.notifications) {
                const deadlineDate = new Date(deadline.date);
                deadlineDate.setHours(0, 0, 0, 0);
                const daysLeft = Math.ceil((deadlineDate - now) / (1000 * 60 * 60 * 24));
                
                if (daysLeft === 3) {
                    bot.sendMessage(userId, 
                        `⚠️ *Напоминание о дедлайне*\n\n` +
                        `${deadline.subject}: ${deadline.task}\n` +
                        `📅 Осталось 3 дня!`,
                        { parse_mode: 'Markdown' }
                    ).catch(() => {});
                } else if (daysLeft === 1) {
                    bot.sendMessage(userId,
                        `🔴 *Срочно! Завтра дедлайн*\n\n` +
                        `${deadline.subject}: ${deadline.task}`,
                        { parse_mode: 'Markdown' }
                    ).catch(() => {});
                } else if (daysLeft === 0) {
                    bot.sendMessage(userId,
                        `🔥 *Дедлайн СЕГОДНЯ!*\n\n` +
                        `${deadline.subject}: ${deadline.task}`,
                        { parse_mode: 'Markdown' }
                    ).catch(() => {});
                }
            }
        }
    } catch (error) {
        console.error('Error in checkDeadlines:', error);
        botStats.errors.push({
            time: new Date(),
            message: error.message,
            type: 'deadline_check'
        });
    }
};

setInterval(() => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    
    if (hour === 8 && minute === 0) {
        morningReminders();
    }
    
    if (minute % 30 === 0) {
        checkDeadlines();
    }
}, 60 * 1000);

// ==================== ВОЗВРАТ В ГЛАВНОЕ МЕНЮ ====================

bot.onText(/🔙 Главное меню/, (msg) => {
    const chatId = msg.chat.id;
    updateStats('🔙 Главное меню');
    bot.sendMessage(chatId, '📱 *Главное меню*', {
        parse_mode: 'Markdown',
        reply_markup: mainMenu.reply_markup
    });
});

// ==================== ОБРАБОТКА КОМАНД ====================

bot.onText(/\/today/, (msg) => {
    bot.emit('text', { ...msg, text: '📅 На сегодня' });
});

bot.onText(/\/tomorrow/, (msg) => {
    bot.emit('text', { ...msg, text: '📅 На завтра' });
});

bot.onText(/\/week/, (msg) => {
    bot.emit('text', { ...msg, text: '📅 На неделю' });
});

bot.onText(/\/firstweek/, (msg) => {
    bot.emit('text', { ...msg, text: '📗 Первая неделя' });
});

bot.onText(/\/secondweek/, (msg) => {
    bot.emit('text', { ...msg, text: '📕 Вторая неделя' });
});

bot.onText(/\/deadlines/, (msg) => {
    bot.emit('text', { ...msg, text: '📝 Активные' });
});

bot.onText(/\/addlesson/, (msg) => {
    bot.emit('text', { ...msg, text: '➕ Добавить пару' });
});

bot.onText(/\/adddeadline/, (msg) => {
    bot.emit('text', { ...msg, text: '➕ Добавить дедлайн' });
});

bot.onText(/\/notes/, (msg) => {
    bot.emit('text', { ...msg, text: '📒 Все заметки' });
});

bot.onText(/\/addnote/, (msg) => {
    bot.emit('text', { ...msg, text: '➕ Создать заметку' });
});

bot.onText(/\/groups/, (msg) => {
    bot.emit('text', { ...msg, text: '👥 Группы' });
});

bot.onText(/\/profile/, (msg) => {
    bot.emit('text', { ...msg, text: '👤 Профиль' });
});

bot.onText(/\/stats/, (msg) => {
    bot.emit('text', { ...msg, text: '📊 Статистика' });
});

bot.onText(/\/myuniversity/, (msg) => {
    bot.emit('text', { ...msg, text: '🏛️ Мой университет' });
});

setInterval(updateUsersCount, 10 * 60 * 1000);

process.on('SIGINT', () => {
    console.log('📊 Сохраняю статистику...');
    fs.writeFileSync(
        path.join(__dirname, '..', 'data', 'stats.json'),
        JSON.stringify(botStats, null, 2)
    );
    process.exit(0);
});

try {
    const statsPath = path.join(__dirname, '..', 'data', 'stats.json');
    if (fs.existsSync(statsPath)) {
        const savedStats = fs.readFileSync(statsPath, 'utf8');
        const oldStats = JSON.parse(savedStats);
        botStats.messagesProcessed = oldStats.messagesProcessed || 0;
        botStats.commandsUsed = oldStats.commandsUsed || {};
        botStats.errors = oldStats.errors || [];
        console.log('📊 Статистика загружена');
    }
} catch (error) {
    console.log('📊 Создаю новую статистику');
}

console.log('✅ Бот успешно запущен!');
console.log('📅 Дата и время:', new Date().toLocaleString('ru-RU'));
console.log('👑 Администраторы:', ADMINS.join(', '));
console.log('🤖 Ожидание сообщений...');