CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL
);

CREATE TABLE IF NOT EXISTS user_apps (
    user_id INTEGER REFERENCES users(id),
    app_name VARCHAR(100) NOT NULL,
    PRIMARY KEY (user_id, app_name)
);

INSERT INTO users (username, password, role) VALUES 
('admin', 'admin123', 'admin'),
('eng1', 'eng123', 'engineer'),
('eng2', 'eng123', 'engineer')
ON CONFLICT (username) DO NOTHING;

INSERT INTO user_apps (user_id, app_name) VALUES 
((SELECT id FROM users WHERE username = 'eng1'), 'payment'),
((SELECT id FROM users WHERE username = 'eng1'), 'auth'),
((SELECT id FROM users WHERE username = 'eng2'), 'load-test-app')
ON CONFLICT DO NOTHING;
