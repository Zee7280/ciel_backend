const { Client } = require('pg');

async function check() {
    const client = new Client({
        host: process.env.DB_HOST || 'localhost',
        port: process.env.DB_PORT || 5432,
        user: process.env.DB_USERNAME || 'postgres',
        password: process.env.DB_PASSWORD || 'postgres',
        database: process.env.DB_NAME || 'ciel'
    });
    try {
        await client.connect();
        const res = await client.query('SELECT * FROM conversations LIMIT 5');
        console.log('Conversations:', res.rows);

        const res2 = await client.query('SELECT * FROM conversation_participants LIMIT 10');
        console.log('Participants:', res2.rows);

        const res3 = await client.query('SELECT COUNT(*) FROM users');
        console.log('User count:', res3.rows[0].count);
    } catch (err) {
        console.error(err);
    } finally {
        await client.end();
    }
}
check();
