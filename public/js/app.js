// Получаем userId из URL
const urlParams = new URLSearchParams(window.location.search);
const userId = urlParams.get('userId') || 'test_user';

// Функция для отправки данных боту
function sendToBot(action, data) {
    if (window.Telegram && window.Telegram.WebApp) {
        window.Telegram.WebApp.sendData(JSON.stringify({
            action: action,
            ...data
        }));
    } else {
        console.log('📦 Данные для бота:', { action, ...data });
        // Для тестирования без Telegram
        alert(`Данные отправлены: ${action}`);
    }
}

// Загрузка данных с бота
async function loadUserData() {
    sendToBot('get_data', {});
    // В реальности данные придут через web_app_data
}

// Сохранение пары
function saveLesson(lesson) {
    sendToBot('add_lesson', { lesson });
}

// Сохранение дедлайна
function saveDeadline(deadline) {
    sendToBot('add_deadline', { deadline });
}

// Отметка дедлайна
function completeDeadline(id) {
    sendToBot('complete_deadline', { id });
}

// Остальной код Mini App (из предыдущего сообщения)
// ... но с использованием функций выше