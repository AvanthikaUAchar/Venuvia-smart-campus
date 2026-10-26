const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize SQLite Database
const db = new sqlite3.Database('./venuvia.db', (err) => {
  if (err) {
    console.error('Error connecting to SQLite database:', err.message);
  } else {
    console.log('Connected to SQLite Database (venuvia.db)');
  }
});

// Create Database Tables
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      department TEXT NOT NULL,
      role TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venue_id TEXT NOT NULL,
      venue_name TEXT NOT NULL,
      event_title TEXT NOT NULL,
      attendees INTEGER DEFAULT 0,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      organizer TEXT NOT NULL,
      priority_rank INTEGER NOT NULL,
      priority_label TEXT NOT NULL,
      creator_role TEXT NOT NULL,
      status TEXT DEFAULT 'Pending',
      user_email TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// Register User
app.post('/api/register', (req, res) => {
  const { name, email, password, department, role } = req.body;
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  const cleanEmail = email.toLowerCase().trim();

  db.get('SELECT * FROM users WHERE email = ?', [cleanEmail], (err, user) => {
    if (err) return res.status(500).json({ error: 'Database query error.' });

    if (user) {
      return res.status(400).json({
        alreadyRegistered: true,
        error: 'You are already registered! Please sign in with your account credentials.'
      });
    }

    const insert = `INSERT INTO users (name, email, password, department, role) VALUES (?, ?, ?, ?, ?)`;
    db.run(insert, [name, cleanEmail, password, department, role], function (err) {
      if (err) return res.status(500).json({ error: 'Failed to register account.' });
      res.status(201).json({ message: 'Registration successful! You can now sign in.' });
    });
  });
});

// User Sign In
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  const cleanEmail = email.toLowerCase().trim();

  if (cleanEmail === 'avanthika@nmamit.in' && password === 'admin123') {
    return res.json({
      message: 'Admin sign in successful!',
      user: { name: 'Avanthika', email: 'avanthika@nmamit.in', role: 'Campus Admin', department: 'Administration' }
    });
  }

  db.get('SELECT * FROM users WHERE email = ? AND password = ?', [cleanEmail, password], (err, user) => {
    if (err) return res.status(500).json({ error: 'Database query error.' });
    if (!user) return res.status(401).json({ error: 'Invalid email or password.' });

    res.json({
      message: 'Sign in successful!',
      user: { id: user.id, name: user.name, email: user.email, department: user.department, role: user.role }
    });
  });
});

// Get Users (Admin only)
app.get('/api/admin/users', (req, res) => {
  const adminEmail = req.headers['admin-email'];
  if (adminEmail !== 'avanthika@nmamit.in') {
    return res.status(403).json({ error: 'Access Denied.' });
  }

  db.all('SELECT id, name, email, department, role, created_at FROM users', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch users.' });
    res.json(rows);
  });
});

// Get All Bookings
app.get('/api/bookings', (req, res) => {
  db.all('SELECT * FROM bookings ORDER BY priority_rank ASC, date ASC, id DESC', [], (err, rows) => {
    if (err) return res.status(500).json({ error: 'Failed to fetch bookings.' });
    res.json(rows);
  });
});

// Create Booking with Conflict & Priority Rules
app.post('/api/bookings', (req, res) => {
  const { venue_id, venue_name, event_title, attendees, date, start_time, end_time, organizer, creator_role, user_email } = req.body;

  if (!user_email) {
    return res.status(401).json({ error: 'Authentication Required: Please sign in to submit a booking.' });
  }

  // Calculate Priority Rank (1 = Highest, 4 = Lowest)
  let priority_rank = 4;
  let priority_label = 'Tier 4: Student / Club';

  if (user_email === 'avanthika@nmamit.in' || creator_role.includes('Admin')) {
    priority_rank = 1;
    priority_label = 'Tier 1: Administrator';
  } else if (creator_role.includes('Principal')) {
    priority_rank = 2;
    priority_label = 'Tier 2: Principal';
  } else if (creator_role.includes('Lecturer') || creator_role.includes('Faculty')) {
    priority_rank = 3;
    priority_label = 'Tier 3: Lecturer';
  }

  // Check for conflicts on the exact venue and date
  db.get('SELECT * FROM bookings WHERE venue_id = ? AND date = ?', [venue_id, date], (err, existing) => {
    if (err) return res.status(500).json({ error: 'Database conflict check error.' });

    if (existing) {
      // Conflict exists! Compare priority ranks
      if (priority_rank < existing.priority_rank) {
        // New booking has HIGHER priority! Remove/replace the existing lower-priority booking
        db.run('DELETE FROM bookings WHERE id = ?', [existing.id], (delErr) => {
          if (delErr) return res.status(500).json({ error: 'Failed to resolve priority preemption.' });

          insertNewBooking();
        });
      } else {
        // Existing booking has equal or higher priority. Block new booking!
        return res.status(400).json({
          error: `Conflict Error: ${venue_name} is already booked on ${date} by a higher or equal priority event ("${existing.event_title}").`
        });
      }
    } else {
      // No conflict, insert directly
      insertNewBooking();
    }
  });

  function insertNewBooking() {
    const query = `
      INSERT INTO bookings (venue_id, venue_name, event_title, attendees, date, start_time, end_time, organizer, priority_rank, priority_label, creator_role, status, user_email)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?)
    `;

    db.run(
      query,
      [
        venue_id,
        venue_name,
        event_title,
        parseInt(attendees) || 0,
        date,
        start_time,
        end_time,
        organizer,
        priority_rank,
        priority_label,
        creator_role,
        user_email
      ],
      function (err) {
        if (err) {
          return res.status(500).json({ error: 'Failed to save booking.' });
        }
        res.status(201).json({ message: 'Booking successfully secured without conflicts!' });
      }
    );
  }
});

// Update Booking Status
app.patch('/api/bookings/:id', (req, res) => {
  const { status, admin_email } = req.body;
  if (admin_email !== 'avanthika@nmamit.in') {
    return res.status(403).json({ error: 'Unauthorized.' });
  }

  db.run('UPDATE bookings SET status = ? WHERE id = ?', [status, req.params.id], (err) => {
    if (err) return res.status(500).json({ error: 'Failed to update status.' });
    res.json({ message: `Booking status updated to ${status}` });
  });
});

app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));