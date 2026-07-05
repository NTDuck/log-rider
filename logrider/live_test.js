const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');

async function login() {
    return new Promise((resolve, reject) => {
        const req = http.request({
            hostname: 'localhost',
            port: 3001,
            path: '/login',
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        }, res => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error('Login failed: ' + data));
                resolve(JSON.parse(data).token);
            });
        });
        req.on('error', reject);
        req.write(JSON.stringify({ username: 'Ayin', password: 'admin123' }));
        req.end();
    });
}

function runScript(scriptName) {
    return new Promise((resolve, reject) => {
        const p = spawn('bash', ['./scripts/' + scriptName], { stdio: 'inherit' });
        p.on('close', code => {
            if (code === 0) resolve();
            else reject(new Error(scriptName + ' exited with ' + code));
        });
    });
}

async function testLivePath(scriptName, expectType) {
    console.log(`\n--- Testing live path with ${scriptName} ---`);
    const token = await login();
    console.log('Logged in, got token.');
    
    return new Promise((resolve, reject) => {
        const ws = new WebSocket('ws://localhost:3001/api/ws', {
            headers: { Cookie: `logrider_token=${token}` }
        });
        
        let received = false;
        
        ws.on('open', async () => {
            console.log('WebSocket connected. Running script...');
            try {
                // Do not wait for script to finish to check for live messages, just start it
                runScript(scriptName).catch(reject);
            } catch (e) {
                reject(e);
            }
        });
        
        ws.on('message', data => {
            const msg = JSON.parse(data);
            if (msg.type === expectType || msg.Trace_ID) {
                console.log(`Received live ${expectType || 'log'} message!`, data.toString().substring(0, 100));
                received = true;
                ws.close();
                resolve();
            }
        });
        
        ws.on('error', reject);
        
        setTimeout(() => {
            if (!received) {
                ws.close();
                reject(new Error('Timeout waiting for live message'));
            }
        }, 15000);
    });
}

(async () => {
    try {
        await runScript('cleanup.sh');
        await testLivePath('test.sh', 'TAGS'); // test.sh generates logs, we wait for TAGS or raw logs
        await runScript('cleanup.sh');
        await testLivePath('test-alert.sh', 'ALERT');
        console.log('\nAll tests passed!');
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
