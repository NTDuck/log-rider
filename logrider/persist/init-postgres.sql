CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,
    allowed_apps TEXT
);

INSERT INTO users (username, password_hash, role, allowed_apps) VALUES 
('admin', '$argon2id$v=19$m=65536,t=2,p=1$QzX/R/8qQzX/R/8qQzX/Rw$QzX/R/8qQzX/R/8qQzX/R/8qQzX/R/8qQzX/R/8qQzU', 'admin', ''),
('eng1', '$argon2id$v=19$m=65536,t=2,p=1$QzX/R/8qQzX/R/8qQzX/Rw$QzX/R/8qQzX/R/8qQzX/R/8qQzX/R/8qQzX/R/8qQzU', 'engineer', 'apple-service,banana-service,orange-service'),
('eng2', '$argon2id$v=19$m=65536,t=2,p=1$QzX/R/8qQzX/R/8qQzX/Rw$QzX/R/8qQzX/R/8qQzX/R/8qQzX/R/8qQzX/R/8qQzU', 'engineer', 'kiwi-service,papaya-service')
ON CONFLICT (username) DO NOTHING;
