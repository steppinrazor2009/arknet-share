const readline = require('readline');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const envPath = path.join(__dirname, '.env');

function prompt(question) {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

async function run() {
  console.log('\n🎬 MovieShare Setup\n');

  // Check if .env exists
  if (fs.existsSync(envPath)) {
    const answer = await prompt('.env already exists. Overwrite? (y/n): ');
    if (answer.toLowerCase() !== 'y') {
      console.log('Setup cancelled.');
      rl.close();
      return;
    }
  }

  // Get admin password
  const password = await prompt('Enter admin password: ');
  if (!password) {
    console.log('❌ Password cannot be empty.');
    rl.close();
    return;
  }

  // Hash password
  const salt = bcrypt.genSaltSync(10);
  const hash = bcrypt.hashSync(password, salt);

  // Generate JWT secret
  const jwtSecret = crypto.randomBytes(32).toString('hex');

  // Write .env file
  const envContent = `PORT=3000
ADMIN_PASSWORD_HASH=${hash}
ADMIN_JWT_SECRET=${jwtSecret}
`;

  fs.writeFileSync(envPath, envContent);
  console.log('\n✅ Setup complete!');
  console.log('✅ .env file created with admin password hash and JWT secret.');
  console.log('\nNext steps:');
  console.log('1. Create the movies/ directory: mkdir movies');
  console.log('2. Add your video files to the movies/ directory');
  console.log('3. Start the app: docker compose up -d');
  console.log('4. Access the admin panel: http://localhost:3000/admin\n');

  rl.close();
}

run().catch((err) => {
  console.error('Error:', err);
  rl.close();
  process.exit(1);
});
