const { Client } = require('pg');

const client = new Client({
    user: 'postgres',
    host: '127.0.0.1',
    database: 'postgres',
    password: 'zain',
    port: 5432,
});

async function createDb() {
    try {
        await client.connect();
        await client.query('CREATE DATABASE ciel');
        console.log('Database ciel created successfully');
    } catch (err) {
        if (err.code === '42P04') {
            console.log('Database ciel already exists');
        } else {
            console.error('Error creating database:', err);
            process.exit(1);
        }
    } finally {
        await client.end();
    }
}

createDb();
