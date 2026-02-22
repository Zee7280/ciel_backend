const { DataSource } = require('typeorm');
const dotenv = require('dotenv');
dotenv.config();

const myDataSource = new DataSource({
    type: "postgres",
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432"),
    username: process.env.DB_USERNAME || "postgres",
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "saevolgo",
    ssl: (process.env.NODE_ENV === 'production' || process.env.VERCEL) ? {
        rejectUnauthorized: false
    } : (process.env.DB_SSL === 'true' ? {
        rejectUnauthorized: false,
    } : undefined),
    synchronize: false
});

async function run() {
    await myDataSource.initialize();

    // Log users
    const users = await myDataSource.query('SELECT id, name FROM users WHERE id = $1', ['900a4eac-814d-46c9-9089-55dac12cc1e4']);
    console.log("Users in DB:", users);

    // Log conversation participants for a specific conversation
    const parts = await myDataSource.query('SELECT * FROM conversation_participants WHERE "conversationId" = $1', ['6fa8e10f-d4e4-48bb-a51c-f198ac9ca106']);
    console.log("Participants DB:", parts);

    process.exit(0);
}
run().catch(console.error);
