# Contributing to Aegis

Thank you for your interest in contributing to Aegis! This guide will help you get started.

---

## Table of Contents

1. [Code of Conduct](#code-of-conduct)
2. [Getting Started](#getting-started)
3. [Development Workflow](#development-workflow)
4. [Coding Standards](#coding-standards)
5. [Testing](#testing)
6. [Pull Request Process](#pull-request-process)
7. [Release Process](#release-process)

---

## Code of Conduct

### Our Pledge

We are committed to providing a welcoming and inclusive environment for all contributors.

### Expected Behavior

- Be respectful and considerate
- Accept constructive criticism gracefully
- Focus on what's best for the project
- Show empathy toward other community members

### Unacceptable Behavior

- Harassment, discrimination, or offensive comments
- Trolling or insulting/derogatory comments
- Publishing others' private information
- Other unprofessional conduct

---

## Getting Started

### Prerequisites

- **Node.js** v20+
- **Python** 3.11+
- **Docker** v24+
- **Git**

### Fork and Clone

1. Fork the repository on GitHub
2. Clone your fork:
   ```bash
   git clone https://github.com/yourusername/aegis.git
   cd aegis
   ```

3. Add upstream remote:
   ```bash
   git remote add upstream https://github.com/original/aegis.git
   ```

### Install Dependencies

```bash
# Backend
npm install

# Frontend
cd frontend && npm install && cd ..

# ML API
cd aegis-ml && pip install -r requirements.txt && cd ..
```

### Run Locally

```bash
# Start dependencies
docker-compose up -d postgres redis

# Run migrations
npm run migrate

# Start gateway
npm run dev
```

---

## Development Workflow

### Branching Strategy

We use **Git Flow**:

- `main` - Production-ready code
- `develop` - Integration branch for features
- `feature/*` - New features
- `bugfix/*` - Bug fixes
- `hotfix/*` - Urgent production fixes

### Creating a Feature Branch

```bash
# Update develop
git checkout develop
git pull upstream develop

# Create feature branch
git checkout -b feature/my-new-feature

# Make changes and commit
git add .
git commit -m "feat: add new feature"

# Push to your fork
git push origin feature/my-new-feature
```

### Commit Message Format

We follow **Conventional Commits**:

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Types**:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Code style changes (formatting, etc.)
- `refactor`: Code refactoring
- `test`: Adding or updating tests
- `chore`: Maintenance tasks

**Examples**:
```
feat(rate-limiter): add sliding window algorithm

Implement sliding window rate limiting using Redis sorted sets.
Provides more accurate rate limiting compared to fixed window.

Closes #123
```

```
fix(monitoring): correct p95 latency calculation

Previous calculation was using p50 instead of p95.

Fixes #456
```

---

## Coding Standards

### TypeScript/JavaScript

**Style Guide**: [Airbnb JavaScript Style Guide](https://github.com/airbnb/javascript)

**Linting**:
```bash
npm run lint
npm run lint:fix
```

**Key Rules**:
- Use TypeScript for type safety
- Prefer `const` over `let`, avoid `var`
- Use async/await over callbacks
- Add JSDoc comments for public APIs
- Keep functions small and focused

**Example**:
```typescript
/**
 * Calculate percentile from array of numbers
 * @param values - Array of numeric values
 * @param percentile - Percentile to calculate (0-1)
 * @returns Percentile value
 */
export function calculatePercentile(
  values: number[],
  percentile: number
): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.floor(sorted.length * percentile);
  return sorted[index];
}
```

### Python

**Style Guide**: [PEP 8](https://pep8.org/)

**Linting**:
```bash
cd aegis-ml
pylint **/*.py
black .
```

**Key Rules**:
- Use type hints
- Maximum line length: 100 characters
- Use descriptive variable names
- Add docstrings to all functions

**Example**:
```python
def calculate_anomaly_score(features: np.ndarray) -> float:
    """
    Calculate anomaly score for given features.

    Args:
        features: NumPy array of feature values

    Returns:
        Anomaly score between 0 and 1
    """
    score = model.decision_function(features)
    return 1 / (1 + np.exp(score))
```

### File Organization

```
src/
├── api/           # API routes and handlers
├── gateway/       # Core gateway logic
├── rate-limiter/  # Rate limiting algorithms
├── monitoring/    # Metrics and alerting
├── ml/            # ML integration
├── storage/       # Database clients
├── utils/         # Shared utilities
└── index.ts       # Entry point
```

---

## Testing

### Running Tests

**Backend**:
```bash
# Unit tests
npm test

# Integration tests
npm run test:integration

# Coverage
npm run test:coverage
```

**Frontend**:
```bash
cd frontend
npm test
```

**ML API**:
```bash
cd aegis-ml
pytest
pytest --cov=models
```

### Writing Tests

**Unit Test Example** (Jest):
```typescript
describe('TokenBucketLimiter', () => {
  let limiter: TokenBucketLimiter;

  beforeEach(() => {
    limiter = new TokenBucketLimiter(mockRedis, 100, 10);
  });

  test('should allow requests within limit', async () => {
    for (let i = 0; i < 100; i++) {
      const allowed = await limiter.checkLimit('client1');
      expect(allowed).toBe(true);
    }
  });

  test('should reject requests exceeding limit', async () => {
    // Use all tokens
    for (let i = 0; i < 100; i++) {
      await limiter.checkLimit('client1');
    }

    // Next request should be rejected
    const allowed = await limiter.checkLimit('client1');
    expect(allowed).toBe(false);
  });
});
```

**Integration Test Example**:
```typescript
describe('Gateway Integration', () => {
  test('should proxy request to upstream', async () => {
    const response = await request(app)
      .get('/api/users')
      .expect(200);

    expect(response.body).toHaveProperty('users');
  });

  test('should apply rate limiting', async () => {
    // Send 101 requests (limit is 100)
    const promises = [];
    for (let i = 0; i < 101; i++) {
      promises.push(request(app).get('/api/test'));
    }

    const responses = await Promise.all(promises);
    const rateLimited = responses.filter(r => r.status === 429);

    expect(rateLimited.length).toBeGreaterThan(0);
  });
});
```

### Test Coverage

Aim for **>80% code coverage**:

```bash
npm run test:coverage
```

Coverage report:
```
File           | % Stmts | % Branch | % Funcs | % Lines |
---------------|---------|----------|---------|---------|
All files      |   85.2  |   78.4   |   82.1  |   85.5  |
 gateway/      |   92.1  |   85.3   |   90.2  |   92.4  |
 rate-limiter/ |   88.5  |   82.1   |   85.7  |   89.1  |
```

---

## Pull Request Process

### Before Submitting

1. **Update from upstream**:
   ```bash
   git checkout develop
   git pull upstream develop
   git checkout feature/my-feature
   git rebase develop
   ```

2. **Run tests**:
   ```bash
   npm test
   npm run lint
   ```

3. **Update documentation** if needed

4. **Add/update tests** for your changes

### Creating a Pull Request

1. Push your branch to your fork
2. Go to GitHub and create a Pull Request
3. Fill out the PR template:

```markdown
## Description
Brief description of changes

## Type of Change
- [ ] Bug fix
- [ ] New feature
- [ ] Breaking change
- [ ] Documentation update

## Testing
- [ ] Tests pass locally
- [ ] Added new tests
- [ ] Updated existing tests

## Checklist
- [ ] Code follows style guidelines
- [ ] Self-review completed
- [ ] Documentation updated
- [ ] No new warnings
```

### Review Process

1. **Automated checks**: CI/CD runs tests and linting
2. **Code review**: Maintainers review your code
3. **Address feedback**: Make requested changes
4. **Approval**: At least one maintainer approval required
5. **Merge**: Maintainer merges your PR

### After Merge

1. Delete your feature branch:
   ```bash
   git branch -d feature/my-feature
   git push origin --delete feature/my-feature
   ```

2. Update your local develop:
   ```bash
   git checkout develop
   git pull upstream develop
   ```

---

## Release Process

### Versioning

We use **Semantic Versioning** (SemVer):

- **MAJOR**: Breaking changes
- **MINOR**: New features (backward-compatible)
- **PATCH**: Bug fixes

Example: `v1.2.3`

### Creating a Release

1. **Update version**:
   ```bash
   npm version minor  # or major/patch
   ```

2. **Update CHANGELOG.md**:
   ```markdown
   ## [1.2.0] - 2024-01-15

   ### Added
   - Sliding window rate limiting algorithm
   - Natural language query API

   ### Fixed
   - Dashboard WebSocket connection issues
   ```

3. **Create release branch**:
   ```bash
   git checkout -b release/v1.2.0
   git push origin release/v1.2.0
   ```

4. **Create GitHub release**:
   - Tag: `v1.2.0`
   - Title: `Release v1.2.0`
   - Description: Copy from CHANGELOG.md

---

## Areas for Contribution

### High Priority

- [ ] Additional rate limiting algorithms (leaky bucket, etc.)
- [ ] OAuth 2.0 authentication
- [ ] GraphQL gateway support
- [ ] gRPC proxying
- [ ] Advanced ML models (LSTM, GNN)

### Documentation

- [ ] Video tutorials
- [ ] More code examples
- [ ] Deployment guides for specific clouds
- [ ] Performance tuning guide

### Testing

- [ ] End-to-end tests with Playwright
- [ ] Performance benchmarks
- [ ] Security testing

### Infrastructure

- [ ] Kubernetes Helm charts
- [ ] Terraform modules for AWS/GCP/Azure
- [ ] CI/CD improvements

---

## Getting Help

- **Documentation**: [docs/](./docs/)
- **GitHub Discussions**: Ask questions
- **Discord**: Real-time chat
- **Email**: dev@aegis.dev

---

## Recognition

Contributors are recognized in:
- `README.md` contributors section
- GitHub contributors page
- Release notes

Thank you for contributing to Aegis! 🎉
