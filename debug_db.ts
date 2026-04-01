import { createConnection } from 'typeorm';
import { Participation } from './src/engagement/entities/participant.entity';
import { User } from './src/users/entities/user.entity';

async function check() {
    const conn = await createConnection({
        type: 'postgres',
        host: '127.0.0.1',
        port: 5432,
        username: 'postgres',
        password: 'zain',
        database: 'zainali',
        entities: [Participation, User],
        synchronize: false,
    });
    const repo = conn.getRepository(Participation);
    const id = '52b82c50-9c2c-4552-8902-f422cde7a257';
    
    console.log('Searching for participation with ID:', id);
    const p = await repo.findOne({ where: { id } });
    if (p) {
        console.log('Found participation:', JSON.stringify(p, null, 2));
    } else {
        console.log('Participation not found by ID. Searching by studentId:', id);
        const p2 = await repo.findOne({ where: { studentId: id } });
        if (p2) {
            console.log('Found participation by studentId:', JSON.stringify(p2, null, 2));
        } else {
            console.log('Not found by studentId either.');
        }
    }
    await conn.close();
}

check().catch(console.error);
