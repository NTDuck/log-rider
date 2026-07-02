import { Client } from 'pg';
const POSTGRES_URI = process.env.POSTGRES_URI || 'postgres://logrider:password@postgres:5432/logrider';
const client = new Client({ connectionString: POSTGRES_URI });

async function run() {
    await client.connect();
    await client.query(`
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            password_hash VARCHAR(255) NOT NULL,
            role VARCHAR(20) NOT NULL,
            allowed_apps TEXT
        );
        CREATE TABLE IF NOT EXISTS alerts (
            id SERIAL PRIMARY KEY,
            timestamp TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            application_name VARCHAR(255) NOT NULL,
            message TEXT NOT NULL,
            count INT DEFAULT 1
        );
    `);
    
    // Insert defaults if empty
    const { rows } = await client.query('SELECT count(*) FROM users');
    if (parseInt(rows[0].count) === 0) {
        const adminHash = await Bun.password.hash('admin123');
        const eng1Hash = await Bun.password.hash('eng123');
        const eng2Hash = await Bun.password.hash('eng123');
        
        await client.query(`INSERT INTO users (username, password_hash, role, allowed_apps) VALUES 
            ('admin', $1, 'admin', ''),
            ('eng1', $2, 'engineer', 'apple-service,banana-service,orange-service'),
            ('eng2', $3, 'engineer', 'kiwi-service,papaya-service')
        `, [adminHash, eng1Hash, eng2Hash]);
        console.log("Inserted default users");
    }
    console.log("Migration complete");
    process.exit(0);
}
run().catch(console.error);
