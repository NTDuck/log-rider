# Real System Validation Guide

## The Correct Approach: Three-Step Correction

When you feel the urge to mock, follow this three-step correction:

### Step 1: DIAGNOSE — Why can't I use the real system?

```
Ask yourself:
- Is the dependency not running? -> Start it (docker, brew services, systemctl)
- Is it not configured? -> Configure it (env vars, connection strings, API keys)
- Is it not accessible? -> Fix network/permissions (firewall, CORS, auth)
- Is it too slow? -> That's a real bug — profile and fix it
- Is it someone else's service? -> Use their staging/dev environment
```

### Step 2: FIX — Make the real system available

```bash
# Database not running
docker run -d --name dev-postgres -p 5432:5432 \
  -e POSTGRES_PASSWORD=devpass postgres:16
psql -h localhost -U postgres -c "CREATE DATABASE myapp_dev;"
pnpm db:migrate && pnpm db:seed

# API not accessible
export API_URL=https://staging-api.example.com
export API_KEY=$(cat .env.development | grep API_KEY | cut -d= -f2)

# Service not configured
cp .env.example .env.development
# Edit .env.development with real dev credentials

# Simulator not working
xcrun simctl shutdown all && xcrun simctl erase all
xcrun simctl boot "iPhone 16"
```

### Step 3: VERIFY — Validate through the real system

```bash
# Verify database
psql -h localhost -U postgres -d myapp_dev -c "SELECT count(*) FROM users;"

# Verify API
curl -s https://staging-api.example.com/health | jq .

# Verify frontend
pnpm dev &
curl -s http://localhost:3000 | head -5

# Verify iOS
xcodebuild -scheme MyApp -destination 'platform=iOS Simulator,name=iPhone 16' build
xcrun simctl launch booted com.example.MyApp
xcrun simctl io booted screenshot e2e-evidence/launch.png
```

## Real-World Example: Mock Drift in Action

**Scenario:** An agent is implementing a user profile page that fetches data from `/api/users/me`.

### The Mocking Path (WRONG)

```typescript
// __tests__/profile.test.tsx — THIS FILE SHOULD NOT EXIST
import { render, screen } from '@testing-library/react';
import { ProfilePage } from '../pages/profile';

jest.mock('../api/client', () => ({
  fetchUser: jest.fn().mockResolvedValue({
    id: 1, name: 'Test User', email: 'test@example.com'
  })
}));

test('shows user name', async () => {
  render(<ProfilePage />);
  expect(await screen.findByText('Test User')).toBeInTheDocument();
});
// "Test passes!" — but the real API returns { id, displayName, emailAddress }
// The mock uses the wrong field names. The real page will crash.
```

### The Functional Validation Path (CORRECT)

```bash
# 1. Start the real system
docker compose up -d  # postgres, redis
pnpm db:migrate && pnpm db:seed
pnpm dev &

# 2. Create a real test user (or use seeded one)
curl -s -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{"displayName":"Alice","emailAddress":"alice@example.com","password":"devpass123"}' \
  | jq . > e2e-evidence/register-response.json

# 3. Log in as real user
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"emailAddress":"alice@example.com","password":"devpass123"}' \
  | jq -r '.token')

# 4. Navigate to profile page and capture evidence
# (Using Playwright MCP or manual browser)
# Screenshot shows: "Alice" in the header, "alice@example.com" in the profile card

# 5. Verify the API contract matches the UI
curl -s http://localhost:3000/api/users/me \
  -H "Authorization: Bearer $TOKEN" \
  | jq . > e2e-evidence/profile-response.json
# Response: {"id": 42, "displayName": "Alice", "emailAddress": "alice@example.com"}
```

The functional validation found the real field names (`displayName`, `emailAddress`)
because it called the real API. The mock would have hidden this mismatch until
production, where users would see a blank profile page.

## What Is NOT Blocked

These are real-system interactions, not mocks:
- Playwright or browser automation (interacts with the real system)
- Database seed scripts (populates real databases with real data)
- API client code that calls real endpoints
- Integration with real external services via staging/dev environments
