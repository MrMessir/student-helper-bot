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
// ID администраторов (ЗАМЕНИТЕ НА СВОИ ID)
const ADMINS = [5772748918]; // Получите свой ID у @userinfobot

// Функция проверки админа
const isAdmin = (userId) => ADMINS.includes(Number(userId));

// Статистика бота
let botStats = {
    startTime: new Date(),
    messagesProcessed: 0,
    commandsUsed: {},
    errors: [],
    usersCount: 0,
    lastRestart: null
};

// Обновление статистики
const updateStats = (command) => {
    botStats.messagesProcessed++;
    botStats.commandsUsed[command] = (botStats.commandsUsed[command] || 0) + 1;
};

// Получение количества пользователей
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

// ==================== ФУНКЦИИ ДЛЯ РАБОТЫ С НЕДЕЛЯМИ ====================

// Определение типа текущей недели (числитель/знаменатель)
const getCurrentWeekType = () => {
    const now = new Date();
    // Начало учебного года (1 сентября)
    const startOfYear = new Date(now.getFullYear(), 8, 1); // Сентябрь (месяц 8)
    
    // Если сейчас раньше 1 сентября, берем прошлый год
    if (now < startOfYear) {
        startOfYear.setFullYear(startOfYear.getFullYear() - 1);
    }
    
    // Разница в днях
    const diffDays = Math.floor((now - startOfYear) / (1000 * 60 * 60 * 24));
    // Номер недели от начала года
    const weekNumber = Math.floor(diffDays / 7) + 1;
    
    // Четная неделя - знаменатель, нечетная - числитель
    return weekNumber % 2 === 0 ? 'denominator' : 'numerator';
};

// Получение типа недели для конкретной даты
const getWeekTypeForDate = (date) => {
    const targetDate = new Date(date);
    const startOfYear = new Date(targetDate.getFullYear(), 8, 1);
    
    if (targetDate < startOfYear) {
        startOfYear.setFullYear(startOfYear.getFullYear() - 1);
    }
    
    const diffDays = Math.floor((targetDate - startOfYear) / (1000 * 60 * 60 * 24));
    const weekNumber = Math.floor(diffDays / 7) + 1;
    
    return weekNumber % 2 === 0 ? 'denominator' : 'numerator';
};

// Форматирование типа недели для отображения
const formatWeekType = (weekType) => {
    const types = {
        'numerator': '📗 Числитель',
        'denominator': '📕 Знаменатель',
        'both': '📘 Каждую неделю'
    };
    return types[weekType] || weekType;
};

// Получение информации о текущей неделе
const getWeekInfo = () => {
    const weekType = getCurrentWeekType();
    const weekTypeText = formatWeekType(weekType);
    const nextWeekType = weekType === 'numerator' ? 'denominator' : 'numerator';
    const nextWeekTypeText = formatWeekType(nextWeekType);
    
    return {
        current: weekType,
        currentText: weekTypeText,
        next: nextWeekType,
        nextText: nextWeekTypeText
    };
};

// ==================== БАЗА ДАННЫХ ====================
const DB_PATH = path.join(__dirname, '..', 'data', 'database.sqlite');
const dataDir = path.join(__dirname, '..', 'data');

// Создаем папку data если её нет
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Подключение к БД
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
        // Таблица пользователей
        db.run(`CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            name TEXT,
            username TEXT,
            group_name TEXT DEFAULT 'Не указана',
            registered_at DATETIME,
            level INTEGER DEFAULT 1,
            experience INTEGER DEFAULT 0,
            settings TEXT DEFAULT '{"notifications":true,"darkTheme":false,"lessonReminders":true,"deadlineReminders":true}'
        )`);

        // Таблица расписания (с поддержкой четности недели)
        db.run(`CREATE TABLE IF NOT EXISTS lessons (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            date TEXT,
            day TEXT,
            time TEXT,
            subject TEXT,
            room TEXT,
            teacher TEXT,
            week_type TEXT DEFAULT 'both', -- 'numerator', 'denominator', 'both'
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

        // Таблица оценок
        db.run(`CREATE TABLE IF NOT EXISTS grades (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            subject TEXT,
            grade INTEGER,
            type TEXT,
            date TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Таблица напоминаний
        db.run(`CREATE TABLE IF NOT EXISTS reminders (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            text TEXT,
            date TEXT,
            time TEXT,
            repeat TEXT CHECK(repeat IN ('none', 'daily', 'weekly')),
            completed BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Таблица истории чата
        db.run(`CREATE TABLE IF NOT EXISTS chat_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id TEXT,
            message TEXT,
            response TEXT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
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
            role TEXT DEFAULT 'member', -- 'owner', 'admin', 'member'
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            points INTEGER DEFAULT 0,
            PRIMARY KEY (group_id, user_id),
            FOREIGN KEY (group_id) REFERENCES groups(id),
            FOREIGN KEY (user_id) REFERENCES users(user_id)
        )`);

        // Таблица для истории очков
        db.run(`CREATE TABLE IF NOT EXISTS points_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT,
            user_id TEXT,
            points INTEGER,
            reason TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES groups(id),
            FOREIGN KEY (user_id) REFERENCES users(user_id)
        )`);

        // Таблица для общих дедлайнов группы
        db.run(`CREATE TABLE IF NOT EXISTS group_deadlines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id TEXT,
            subject TEXT,
            task TEXT,
            date TEXT,
            priority TEXT CHECK(priority IN ('high', 'medium', 'low')),
            created_by TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES groups(id)
        )`);

        // Таблица для общих пар группы
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
                        deadlineReminders: true
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
                if (row && row.settings) {
                    try {
                        row.settings = JSON.parse(row.settings);
                    } catch (e) {
                        row.settings = { notifications: true };
                    }
                }
                resolve(row);
            });
        });
    },
    
    update: (userId, data) => {
        return new Promise((resolve, reject) => {
            const fields = Object.keys(data).map(key => {
                if (key === 'settings' && typeof data[key] === 'object') {
                    data[key] = JSON.stringify(data[key]);
                }
                return `${key} = ?`;
            }).join(', ');
            
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
                
                // Проверка повышения уровня (100 опыта за уровень)
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
            
            if (weekType) {
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
        return new Promise((resolve, reject) => {
            const weekType = getWeekTypeForDate(date);
            
            db.all(
                'SELECT * FROM lessons WHERE user_id = ? AND (date = ? OR (day = ? AND (week_type = ? OR week_type = "both"))) ORDER BY time',
                [userId, date, new Date(date).toLocaleDateString('ru-RU', { weekday: 'long' }), weekType],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });
    },
    
    findByDay: (userId, day, weekType = null) => {
        return new Promise((resolve, reject) => {
            let query = 'SELECT * FROM lessons WHERE user_id = ? AND day = ?';
            let params = [userId, day];
            
            if (weekType) {
                query += ' AND (week_type = ? OR week_type = "both")';
                params.push(weekType);
            }
            
            query += ' ORDER BY time';
            
            db.all(query, params, (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
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
    // Создание новой группы
    create: (name, ownerId) => {
        return new Promise((resolve, reject) => {
            const groupId = 'group_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
            const inviteCode = Math.random().toString(36).substr(2, 8).toUpperCase();
            
            db.run(
                'INSERT INTO groups (id, name, owner_id, invite_code) VALUES (?, ?, ?, ?)',
                [groupId, name, ownerId, inviteCode],
                function(err) {
                    if (err) reject(err);
                    
                    // Добавляем создателя как owner
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
    
    // Получение группы по ID
    findById: (groupId) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT * FROM groups WHERE id = ?', [groupId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
    },
    
    // Получение группы по коду приглашения
    findByInviteCode: (code) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT * FROM groups WHERE invite_code = ?', [code], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
    },
    
    // Получение групп пользователя
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
    
    // Присоединение к группе по коду
    join: (inviteCode, userId) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT * FROM groups WHERE invite_code = ?', [inviteCode], (err, group) => {
                if (err) reject(err);
                if (!group) {
                    reject(new Error('Группа не найдена'));
                    return;
                }
                
                // Проверяем, не состоит ли уже пользователь
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
    
    // Получение участников группы
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
    
    // Проверка роли пользователя
    getUserRole: (groupId, userId) => {
        return new Promise((resolve, reject) => {
            db.get('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', 
                [groupId, userId], (err, row) => {
                if (err) reject(err);
                resolve(row?.role || null);
            });
        });
    },
    
    // Добавление очков участнику
    addPoints: (groupId, userId, points, reason) => {
        return new Promise((resolve, reject) => {
            db.run(
                'UPDATE group_members SET points = points + ? WHERE group_id = ? AND user_id = ?',
                [points, groupId, userId],
                function(err) {
                    if (err) reject(err);
                    
                    // Записываем в историю
                    db.run(
                        'INSERT INTO points_history (group_id, user_id, points, reason) VALUES (?, ?, ?, ?)',
                        [groupId, userId, points, reason],
                        function(err) {
                            if (err) reject(err);
                            resolve(this.changes);
                        }
                    );
                }
            );
        });
    },
    
    // Получение турнирной таблицы
    getLeaderboard: (groupId, limit = 10) => {
        return new Promise((resolve, reject) => {
            db.all(`
                SELECT gm.user_id, u.name, u.username, gm.points, gm.role,
                       (SELECT COUNT(*) FROM points_history WHERE user_id = gm.user_id AND group_id = ?) as actions
                FROM group_members gm
                JOIN users u ON gm.user_id = u.user_id
                WHERE gm.group_id = ?
                ORDER BY gm.points DESC
                LIMIT ?
            `, [groupId, groupId, limit], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
    },
    
    // Обновление расписания группы (только для старосты)
    addGroupLesson: (groupId, lessonData, userId) => {
        return new Promise((resolve, reject) => {
            // Проверяем права
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
    
    // Добавление общего дедлайна
    addGroupDeadline: (groupId, deadlineData, userId) => {
        return new Promise((resolve, reject) => {
            // Проверяем права
            db.get('SELECT role FROM group_members WHERE group_id = ? AND user_id = ?', 
                [groupId, userId], (err, row) => {
                if (err) reject(err);
                if (!row || (row.role !== 'owner' && row.role !== 'admin')) {
                    reject(new Error('Недостаточно прав'));
                    return;
                }
                
                const { subject, task, date, priority } = deadlineData;
                db.run(
                    'INSERT INTO group_deadlines (group_id, subject, task, date, priority, created_by) VALUES (?, ?, ?, ?, ?, ?)',
                    [groupId, subject, task, date, priority, userId],
                    function(err) {
                        if (err) reject(err);
                        resolve({ id: this.lastID, ...deadlineData });
                    }
                );
            });
        });
    },
    
    // Получение расписания группы
    getGroupLessons: (groupId, date = null) => {
        return new Promise((resolve, reject) => {
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
        });
    },
    
    // Получение расписания группы по типу недели
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
    },
    
    // Получение дедлайнов группы
    getGroupDeadlines: (groupId, upcoming = false) => {
        return new Promise((resolve, reject) => {
            let query = 'SELECT * FROM group_deadlines WHERE group_id = ?';
            let params = [groupId];
            
            if (upcoming) {
                const today = new Date().toISOString().split('T')[0];
                query += ' AND date >= ?';
                params.push(today);
            }
            
            query += ' ORDER BY date';
            
            db.all(query, params, (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
    }
};

// ==================== ПЕРЕХВАТ СООБЩЕНИЙ ДЛЯ СТАТИСТИКИ ====================
// Сохраняем оригинальный метод sendMessage
const originalSendMessage = bot.sendMessage;

// Переопределяем для подсчета сообщений
bot.sendMessage = function(chatId, text, options) {
    botStats.messagesProcessed++;
    return originalSendMessage.call(this, chatId, text, options);
};

// Обновляем статистику при каждом сообщении
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

// Глобальные обработчики ошибок
process.on('uncaughtException', (error) => {
    console.error('❌ Необработанная ошибка:', error);
    botStats.errors.push({
        time: new Date(),
        message: error.message,
        stack: error.stack,
        type: 'uncaught'
    });
    
    // Ограничиваем количество хранимых ошибок
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

// Скрытая команда для админов (/admin)
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
        
        // Сохраняем сообщение для рассылки
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
                // Задержка чтобы не спамить
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
                    (SELECT COUNT(*) FROM groups) as groups,
                    (SELECT COUNT(*) FROM chat_history) as chats
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
            `👥 Групп: ${stats.groups}\n` +
            `💬 Сообщений в истории: ${stats.chats}`;
        
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
        
        // Сохраняем статистику перед перезапуском
        botStats.lastRestart = new Date();
        fs.writeFileSync(
            path.join(__dirname, '..', 'data', 'stats.json'),
            JSON.stringify(botStats, null, 2)
        );
        
        // Перезапускаем процесс
        setTimeout(() => process.exit(0), 1000);
    } else {
        bot.sendMessage(chatId, '❌ Перезапуск отменен');
    }
});

// ==================== КОМАНДА /start ====================
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('/start');
    
    try {
        const { user, created } = await User.findOrCreate(userId, {
            name: msg.from.first_name || 'Пользователь',
            username: msg.from.username || ''
        });
        
        const welcomeMessage = created 
            ? `🎓 Добро пожаловать, ${msg.from.first_name || 'друг'}!\n\nРад познакомиться! 👋`
            : `🎓 С возвращением, ${msg.from.first_name || 'друг'}! 👋`;
        
        bot.sendMessage(
            chatId,
            `${welcomeMessage}\n\n` +
            `Я твой умный помощник для учёбы 🤖\n\n` +
            `✨ Что я умею:\n` +
            `• Отвечать на вопросы (Gemini AI)\n` +
            `• Хранить расписание с учетом числителя/знаменателя\n` +
            `• Отслеживать дедлайны\n` +
            `• Вести заметки и оценки\n` +
            `• Создавать группы с турнирной таблицей\n` +
            `• Напоминать о важном\n` +
            `• Синхронизироваться с Mini App\n\n` +
            `📱 Открой Mini App для удобного управления!`,
            mainMenu
        );
    } catch (error) {
        console.error('Error in /start:', error);
        bot.sendMessage(chatId, '❌ Ошибка при запуске. Попробуй еще раз.');
    }
});

// ==================== КОМАНДА /help ====================
bot.onText(/\/help/, (msg) => {
    const chatId = msg.chat.id;
    updateStats('/help');
    
    const helpText = 
        '📋 *Список команд:*\n\n' +
        '*/start* - Запуск бота\n' +
        '*/help* - Показать помощь\n' +
        '*/ask [вопрос]* - Спросить Gemini AI\n' +
        '*/today* - Пары на сегодня\n' +
        '*/tomorrow* - Пары на завтра\n' +
        '*/week* - Расписание на неделю\n' +
        '*/numerator* - Расписание на числитель\n' +
        '*/denominator* - Расписание на знаменатель\n' +
        '*/deadlines* - Активные дедлайны\n' +
        '*/addlesson* - Добавить пару\n' +
        '*/adddeadline* - Добавить дедлайн\n' +
        '*/notes* - Список заметок\n' +
        '*/addnote* - Создать заметку\n' +
        '*/grades* - Оценки\n' +
        '*/groups* - Управление группами\n' +
        '*/profile* - Профиль\n' +
        '*/stats* - Статистика\n' +
        '*/clear* - Очистить данные\n\n' +
        '📱 *Mini App:*\n' +
        '*/app* - Открыть Mini App';
    
    bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

// ==================== КОМАНДА ДЛЯ ПОЛУЧЕНИЯ ID ====================
bot.onText(/\/myid/, (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;
    updateStats('/myid');
    bot.sendMessage(chatId, `🆔 Ваш Telegram ID: \`${userId}\``, { parse_mode: 'Markdown' });
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
        
        if (data.action === 'add_lesson') {
            const lesson = data.lesson;
            
            // Определяем день недели
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
            
            // Начисляем опыт
            const expResult = await User.addExperience(userId, 10);
            
            // Начисляем очки в группах
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
            
            // Начисляем опыт
            const expResult = await User.addExperience(userId, 15);
            
            // Начисляем очки в группах
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
            
            // Начисляем опыт за выполнение
            const expResult = await User.addExperience(userId, 20);
            
            // Начисляем очки в группах
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
        else if (data.action === 'update_settings') {
            const user = await User.findByPk(userId);
            if (user) {
                let settings = user.settings || {};
                settings[data.setting] = data.value;
                
                await User.update(userId, { settings });
                await bot.sendMessage(chatId, `⚙️ Настройка "${data.setting}" обновлена`);
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

// Функция для работы с Gemini
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

bot.onText(/📅 Расписание/, (msg) => {
    const chatId = msg.chat.id;
    updateStats('📅 Расписание');
    
    const weekInfo = getWeekInfo();
    
    const menu = {
        reply_markup: {
            keyboard: [
                ['📅 На сегодня', '📅 На завтра'],
                ['📗 Числитель', '📕 Знаменатель'],
                ['📅 На неделю', '➕ Добавить пару'],
                ['🔙 Главное меню']
            ],
            resize_keyboard: true
        }
    };
    
    bot.sendMessage(chatId, `📅 *Управление расписанием*\n${weekInfo.currentText}`, {
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
        const weekType = getCurrentWeekType();
        const weekTypeText = formatWeekType(weekType);
        
        const lessons = await Lesson.findByDate(userId, today);
        
        if (lessons.length === 0) {
            bot.sendMessage(chatId, `📅 Сегодня пар нет. Отдыхай! 🎉\n\n${weekTypeText}`);
            return;
        }
        
        let message = `📅 *Расписание на сегодня*\n${weekTypeText}\n\n`;
        lessons.sort((a, b) => a.time.localeCompare(b.time));
        lessons.forEach((l, i) => {
            const weekIcon = l.week_type === 'both' ? '📘' : 
                            l.week_type === 'numerator' ? '📗' : '📕';
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
        const weekType = getWeekTypeForDate(dateStr);
        const weekTypeText = formatWeekType(weekType);
        
        const lessons = await Lesson.findByDate(userId, dateStr);
        
        if (lessons.length === 0) {
            bot.sendMessage(chatId, `📅 Завтра пар нет. Можно отдохнуть! 🎉\n\n${weekTypeText}`);
            return;
        }
        
        let message = `📅 *Расписание на завтра*\n${weekTypeText}\n\n`;
        lessons.sort((a, b) => a.time.localeCompare(b.time));
        lessons.forEach((l, i) => {
            const weekIcon = l.week_type === 'both' ? '📘' : 
                            l.week_type === 'numerator' ? '📗' : '📕';
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

// Числитель
bot.onText(/📗 Числитель/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('📗 Числитель');
    
    try {
        const lessons = await Lesson.getByWeekType(userId, 'numerator');
        const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
        
        let message = '📗 *Расписание на числитель*\n\n';
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
            message += 'Нет пар в числитель';
        }
        
        bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (error) {
        console.error(error);
        bot.sendMessage(chatId, '❌ Ошибка загрузки расписания');
    }
});

// Знаменатель
bot.onText(/📕 Знаменатель/, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id.toString();
    updateStats('📕 Знаменатель');
    
    try {
        const lessons = await Lesson.getByWeekType(userId, 'denominator');
        const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
        
        let message = '📕 *Расписание на знаменатель*\n\n';
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
            message += 'Нет пар в знаменатель';
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
        const weekInfo = getWeekInfo();
        const days = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
        
        let message = `📅 *Расписание на неделю*\n${weekInfo.currentText}\n\n`;
        let hasLessons = false;
        
        for (const day of days) {
            const dayLessons = lessons.filter(l => l.day === day);
            if (dayLessons.length > 0) {
                hasLessons = true;
                dayLessons.sort((a, b) => a.time.localeCompare(b.time));
                message += `*${day}:*\n`;
                dayLessons.forEach(l => {
                    const weekIcon = l.week_type === 'both' ? '📘' : 
                                    l.week_type === 'numerator' ? '📗' : '📕';
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
bot.onText(/➕ Добавить пару/, (msg) => {
    const chatId = msg.chat.id;
    updateStats('➕ Добавить пару');
    
    const weekTypeKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📘 Каждую неделю', callback_data: 'lesson_week_both' }],
                [{ text: '📗 Только в числитель', callback_data: 'lesson_week_numerator' }],
                [{ text: '📕 Только в знаменатель', callback_data: 'lesson_week_denominator' }]
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
    
    // Сохраняем состояние для выбора недели
    bot.lessonWeekType = null;
});

// Обработка выбора типа недели
bot.on('callback_query', async (callbackQuery) => {
    if (!callbackQuery.data.startsWith('lesson_week_')) return;
    
    const chatId = callbackQuery.message.chat.id;
    const weekType = callbackQuery.data.replace('lesson_week_', '');
    
    bot.answerCallbackQuery(callbackQuery.id);
    bot.lessonWeekType = weekType;
    
    const weekTypeText = {
        'both': '📘 Каждую неделю',
        'numerator': '📗 Числитель',
        'denominator': '📕 Знаменатель'
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
            
            // Проверка формата даты
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
                bot.sendMessage(chatId, '❌ Неверный формат даты. Используйте ГГГГ-ММ-ДД');
                return;
            }
            
            try {
                // Определяем день недели
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
                
                // Начисляем опыт
                await User.addExperience(userId, 10);
                
                // Начисляем очки в группах
                const groups = await Group.getUserGroups(userId);
                for (const group of groups) {
                    await Group.addPoints(group.id, userId, 5, 'lesson_added');
                }
                
                const weekTypeEmoji = bot.lessonWeekType === 'both' ? '📘' : 
                                     bot.lessonWeekType === 'numerator' ? '📗' : '📕';
                
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
                
                // Начисляем опыт
                await User.addExperience(userId, 15);
                
                // Начисляем очки в группах
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
                
                // Начисляем опыт
                await User.addExperience(userId, 5);
                
                // Начисляем очки в группах
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
            
            // Начисляем очки за создание группы
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
                        [{ text: '📝 Дедлайны группы', callback_data: `group_deadlines_${group.id}` }],
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
            
            // Начисляем очки за вступление
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
                message += `   ⭐ Очки: ${member.points} | Действий: ${member.actions}\n\n`;
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
        const weekInfo = getWeekInfo();
        
        const today = new Date().toISOString().split('T')[0];
        const lessons = await Group.getGroupLessons(groupId, today);
        
        let message = `📅 *Расписание группы ${group.name}*\n${weekInfo.currentText}\n\n`;
        
        if (lessons.length === 0) {
            message += 'Сегодня пар нет 🎉';
        } else {
            lessons.sort((a, b) => a.time.localeCompare(b.time));
            lessons.forEach((l, i) => {
                const weekIcon = l.week_type === 'both' ? '📘' : 
                                l.week_type === 'numerator' ? '📗' : '📕';
                message += `${i+1}. ${weekIcon} *${l.subject}*\n`;
                message += `   ⏰ ${l.time} | 🏢 ${l.room}\n`;
                message += `   👨‍🏫 ${l.teacher}\n\n`;
            });
        }
        
        const buttons = [
            [{ text: '📗 Числитель', callback_data: `group_schedule_week_${groupId}_numerator` }],
            [{ text: '📕 Знаменатель', callback_data: `group_schedule_week_${groupId}_denominator` }],
            [{ text: '📅 На неделю', callback_data: `group_schedule_week_${groupId}_both` }]
        ];
        
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
        const weekTypeText = formatWeekType(weekType);
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
                                    l.week_type === 'numerator' ? '📗' : '📕';
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
    
    // Проверяем права
    const role = await Group.getUserRole(groupId, userId);
    if (role !== 'owner' && role !== 'admin') {
        bot.sendMessage(chatId, '⛔ Только староста и админы могут добавлять пары');
        return;
    }
    
    const weekTypeKeyboard = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '📘 Каждую неделю', callback_data: `group_lesson_week_${groupId}_both` }],
                [{ text: '📗 Только в числитель', callback_data: `group_lesson_week_${groupId}_numerator` }],
                [{ text: '📕 Только в знаменатель', callback_data: `group_lesson_week_${groupId}_denominator` }]
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
    
    const weekTypeText = {
        'both': '📘 Каждую неделю',
        'numerator': '📗 Числитель',
        'denominator': '📕 Знаменатель'
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
                    date, day, time, subject, room, teacher, week_type: weekType
                }, userId);
                
                // Начисляем очки создателю
                await Group.addPoints(groupId, userId, 10, 'group_lesson_added');
                
                bot.sendMessage(chatId, '✅ Пара добавлена в расписание группы!');
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
            [{ text: '📝 Дедлайны', callback_data: `group_deadlines_${groupId}` }],
            [{ text: '👥 Участники', callback_data: `group_members_${groupId}` }]
        ];
        
        // Если староста, добавляем админ-кнопки
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
        const settings = user?.settings || { notifications: true };
        
        const menu = {
            reply_markup: {
                keyboard: [
                    ['👤 Профиль', '📝 Изменить группу'],
                    [`🔔 Уведомления: ${settings.notifications ? '✅' : '❌'}`],
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
        
        const daysActive = Math.ceil((new Date() - new Date(user.registered_at)) / (1000 * 60 * 60 * 24));
        
        const message = 
            `👤 *Профиль*\n\n` +
            `Имя: ${user.name}\n` +
            `Группа: ${user.group_name || 'Не указана'}\n` +
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
        let settings = user.settings || { notifications: true };
        settings.notifications = !settings.notifications;
        
        await User.update(userId, { settings });
        
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
                // Очищаем все таблицы для пользователя
                db.run('DELETE FROM lessons WHERE user_id = ?', [userId]);
                db.run('DELETE FROM deadlines WHERE user_id = ?', [userId]);
                db.run('DELETE FROM notes WHERE user_id = ?', [userId]);
                db.run('DELETE FROM reminders WHERE user_id = ?', [userId]);
                
                // Не удаляем из групп, только сбрасываем очки
                db.run('UPDATE group_members SET points = 0 WHERE user_id = ?', [userId]);
                
                // Сбрасываем опыт и уровень
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

// ==================== БЫСТРЫЕ КОМАНДЫ ====================

bot.onText(/📱 Быстрые команды/, (msg) => {
    const chatId = msg.chat.id;
    updateStats('📱 Быстрые команды');
    
    bot.sendMessage(chatId, 
        '📱 *Быстрые команды*\n\n' +
        '/today - пары сегодня\n' +
        '/tomorrow - пары завтра\n' +
        '/week - расписание на неделю\n' +
        '/numerator - расписание на числитель\n' +
        '/denominator - расписание на знаменатель\n' +
        '/deadlines - активные дедлайны\n' +
        '/addlesson - добавить пару\n' +
        '/adddeadline - добавить дедлайн\n' +
        '/notes - заметки\n' +
        '/groups - управление группами\n' +
        '/profile - профиль\n' +
        '/stats - статистика\n' +
        '/ask [вопрос] - спросить Gemini AI\n' +
        '/app - открыть Mini App',
        { parse_mode: 'Markdown' }
    );
});

// ==================== АВТОМАТИЧЕСКИЕ ФУНКЦИИ ====================

// Утренние напоминания
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
                const weekType = getCurrentWeekType();
                const weekTypeText = formatWeekType(weekType);
                
                const lessons = await Lesson.findByDay(userId, dayName, weekType);
                const deadlines = await Deadline.getUpcoming(userId, 7);
                
                if (lessons.length > 0 || deadlines.length > 0) {
                    let message = `🌅 *Доброе утро!*\n${weekTypeText}\n\n`;
                    
                    if (lessons.length > 0) {
                        message += `📅 *Пары сегодня:*\n`;
                        lessons.sort((a, b) => a.time.localeCompare(b.time));
                        lessons.forEach(l => {
                            const weekIcon = l.week_type === 'both' ? '📘' : 
                                            l.week_type === 'numerator' ? '📗' : '📕';
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

// Проверка дедлайнов
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

// Запуск автоматических функций
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

bot.onText(/\/numerator/, (msg) => {
    bot.emit('text', { ...msg, text: '📗 Числитель' });
});

bot.onText(/\/denominator/, (msg) => {
    bot.emit('text', { ...msg, text: '📕 Знаменатель' });
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

// ==================== ПЕРИОДИЧЕСКОЕ ОБНОВЛЕНИЕ СТАТИСТИКИ ====================

// Обновляем количество пользователей каждые 10 минут
setInterval(updateUsersCount, 10 * 60 * 1000);

// Сохраняем статистику в файл при выходе
process.on('SIGINT', () => {
    console.log('📊 Сохраняю статистику...');
    fs.writeFileSync(
        path.join(__dirname, '..', 'data', 'stats.json'),
        JSON.stringify(botStats, null, 2)
    );
    process.exit(0);
});

// Загружаем статистику при запуске
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

// ==================== ЗАПУСК ====================

console.log('✅ Бот успешно запущен!');
console.log('📅 Дата и время:', new Date().toLocaleString('ru-RU'));
console.log('👑 Администраторы:', ADMINS.join(', '));
console.log('📗 Текущая неделя:', getWeekInfo().currentText);
console.log('🤖 Ожидание сообщений...');