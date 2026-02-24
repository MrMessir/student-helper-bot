const axios = require('axios');

const GEMINI_API_KEY = 'AIzaSyBsLpx7pKI9ru06UAJvrXxtWTVnGcyRZ6s'; // Замените на свой ключ Gemini
// Используем правильную модель - gemini-1.5-pro или gemini-1.5-flash
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

async function testGemini() {
    try {
        console.log('🔄 Тестируем подключение к Gemini API...');
        console.log('Ключ:', GEMINI_API_KEY.substring(0, 10) + '...');
        console.log('URL:', GEMINI_URL);
        
        const response = await axios.post(GEMINI_URL, {
            contents: [{
                parts: [{
                    text: "Привет! Как дела? Ответь одним предложением на русском."
                }]
            }],
            generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 100
            }
        }, {
            timeout: 10000,
            headers: {
                'Content-Type': 'application/json'
            }
        });
        
        console.log('✅ Успешно!');
        console.log('Ответ:', response.data.candidates[0].content.parts[0].text);
        
    } catch (error) {
        console.error('❌ Ошибка:');
        
        if (error.response) {
            console.error('Статус:', error.response.status);
            console.error('Данные:', JSON.stringify(error.response.data, null, 2));
            
            // Если и эта модель не работает, покажем доступные модели
            if (error.response.status === 404) {
                console.log('\n🔍 Модель не найдена. Проверьте доступные модели:');
                await listGeminiModels();
            }
        } else {
            console.error('Ошибка:', error.message);
        }
    }
}

// Функция для просмотра доступных моделей
async function listGeminiModels() {
    try {
        const modelsUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${GEMINI_API_KEY}`;
        const response = await axios.get(modelsUrl);
        
        console.log('\n📋 Доступные модели:');
        response.data.models.forEach(model => {
            if (model.name.includes('gemini')) {
                console.log(`- ${model.name} (поддерживает: ${model.supportedGenerationMethods.join(', ')})`);
            }
        });
    } catch (error) {
        console.error('Не удалось получить список моделей:', error.message);
    }
}

testGemini();