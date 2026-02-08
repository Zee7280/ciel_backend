const { Client } = require('pg');

async function dropUsersTable() {
    const client = new Client({
        host: '127.0.0.1',
        port: 5432,
        user: 'postgres',
        password: 'zain',
        database: 'ciel',
    });

    try {
        await client.connect();
        console.log('Connected to database');

        await client.query('DROP TABLE IF EXISTS users CASCADE;');
        console.log('Users table dropped successfully');

        await client.end();
        console.log('Done!');
    } catch (error) {
        console.error('Error:', error);
        process.exit(1);
    }
}

dropUsersTable();
