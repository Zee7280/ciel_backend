const axios = require('axios');

async function test() {
    try {
        const response = await axios.get('http://localhost:3001/api/v1/chat/conversations', {
            headers: {
                // We need a token. I'll try to get one if possible or just see the error.
                // Usually 500 happens AFTER auth.
            }
        });
        console.log(response.data);
    } catch (error) {
        if (error.response) {
            console.log('Status:', error.response.status);
            console.log('Data:', error.response.data);
        } else {
            console.log('Error:', error.message);
        }
    }
}

test();
