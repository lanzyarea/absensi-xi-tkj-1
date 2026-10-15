const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const crypto = require('crypto');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_HOURS = 24;
const STATUS_ALLOWED = ['Hadir', 'Izin', 'Sakit', 'Alfa'];

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Inisialisasi Database SQLite
// Di Vercel, filesystem hanya bisa ditulis di /tmp (bersifat sementara)
const dbFile = process.env.VERCEL
    ? path.join('/tmp', 'absensi.db')
    : path.join(__dirname, 'absensi.db');
const db = new sqlite3.Database(dbFile, (err) => {
    if (err) {
        console.error('Gagal koneksi ke database:', err.message);
    } else {
        console.log('Terhubung ke database SQLite.');
    }
});

// ---------------------------------------------------------------------------
// Helper promise-based untuk SQLite
// ---------------------------------------------------------------------------
const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); });
});
const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => { err ? reject(err) : resolve(row); });
});
const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => { err ? reject(err) : resolve(rows); });
});
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------------------------------------------------------------------------
// Hash password (scrypt + salt, tanpa dependency tambahan)
// ---------------------------------------------------------------------------
function hashPassword(password) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.scryptSync(password, salt, 32).toString('hex');
    return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
    const [salt, hash] = String(stored || '').split(':');
    if (!salt || !hash) return false;
    const test = crypto.scryptSync(password, salt, 32).toString('hex');
    const a = Buffer.from(hash, 'hex');
    const b = Buffer.from(test, 'hex');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function publicUser(row) {
    return {
        id: row.id,
        username: row.username,
        name: row.name,
        role: row.role,
        ekskul_id: row.ekskul_id || null,
        ekskul_name: row.ekskul_name || null
    };
}

function canAccessEkskul(user, ekskulId) {
    return user.role === 'admin' || (user.role === 'pembina' && user.ekskul_id === ekskulId);
}

// ---------------------------------------------------------------------------
// Skema Database + Seed Data
// ---------------------------------------------------------------------------
async function initDb() {
    // Pengguna (admin sekolah / pembina ekskul)
    await run(`CREATE TABLE IF NOT EXISTS ekskul (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        schedule_day TEXT NOT NULL DEFAULT '',
        schedule_time TEXT NOT NULL DEFAULT ''
    )`);

    await run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('admin','pembina')),
        ekskul_id INTEGER,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        FOREIGN KEY(ekskul_id) REFERENCES ekskul(id)
    )`);

    // Data siswa (bisa ikut lebih dari satu ekskul)
    await run(`CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kelas TEXT NOT NULL DEFAULT ''
    )`);

    await run(`CREATE TABLE IF NOT EXISTS ekskul_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ekskul_id INTEGER NOT NULL,
        student_id TEXT NOT NULL,
        joined_at TEXT NOT NULL DEFAULT (date('now','localtime')),
        UNIQUE(ekskul_id, student_id),
        FOREIGN KEY(ekskul_id) REFERENCES ekskul(id),
        FOREIGN KEY(student_id) REFERENCES students(id)
    )`);

    // Absensi: satu baris per siswa per ekskul per tanggal
    await run(`CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ekskul_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        student_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('Hadir','Izin','Sakit','Alfa')),
        note TEXT NOT NULL DEFAULT '',
        recorded_by INTEGER,
        FOREIGN KEY(ekskul_id) REFERENCES ekskul(id),
        FOREIGN KEY(student_id) REFERENCES students(id)
    )`);
    await run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance
        ON attendance(ekskul_id, date, student_id)`);

    // Sesi login (token + masa berlaku)
    await run(`CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        expires_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // --- Seed ekskul ---
    const { c: ekCount } = await get('SELECT COUNT(*) AS c FROM ekskul');
    if (ekCount === 0) {
        const ekskulList = [
            ['Futsal', 'Jumat', '15:30'],
            ['Basket', 'Selasa', '15:30'],
            ['Pramuka', 'Jumat', '14:00'],
            ['PMR', 'Kamis', '15:00'],
            ['Paskibra', 'Rabu', '14:30'],
            ['Seni Tari', 'Sabtu', '08:00'],
            ['Volly', 'Selasa', '15:30']
        ];
        const stmt = 'INSERT INTO ekskul (name, schedule_day, schedule_time) VALUES (?, ?, ?)';
        for (const e of ekskulList) await run(stmt, e);
        console.log(`${ekskulList.length} ekskul berhasil di-seed.`);
    }

    // --- Seed akun pengguna ---
    const { c: userCount } = await get('SELECT COUNT(*) AS c FROM users');
    if (userCount === 0) {
        await run(
            'INSERT INTO users (username, password_hash, name, role, ekskul_id) VALUES (?, ?, ?, ?, ?)',
            ['admin', hashPassword('admin123'), 'Administrator Sekolah', 'admin', null]
        );
        const pembina = [
            ['pakbudi', 'budi123', 'Pak Budi Santoso', 'Futsal'],
            ['pakdoni', 'doni123', 'Pak Doni Pratama', 'Basket'],
            ['burina', 'rina123', 'Bu Rina Amelia', 'Pramuka'],
            ['busari', 'sari123', 'Bu Sari Wulandari', 'PMR'],
            ['pakherman', 'herman123', 'Pak Herman Gunawan', 'Paskibra'],
            ['bulestari', 'lestari123', 'Bu Lestari Handayani', 'Seni Tari']
        ];
        for (const [username, pass, name, ekskulName] of pembina) {
            await run(
                `INSERT INTO users (username, password_hash, name, role, ekskul_id)
                 VALUES (?, ?, ?, 'pembina', (SELECT id FROM ekskul WHERE name = ?))`,
                [username, hashPassword(pass), name, ekskulName]
            );
        }
        console.log('Akun admin + 6 pembina berhasil di-seed.');
    }

    // --- Seed 35 siswa + keanggotaan ekskul ---
    const { c: studentCount } = await get('SELECT COUNT(*) AS c FROM students');
    if (studentCount === 0) {
        const names = [
            'Ahmad Fauzi', 'Anisa Rahmawati', 'Arya Saputra', 'Aurel Putri', 'Bima Prasetyo',
            'Cika Melania', 'Danuarta Pratama', 'Dinda Kirana', 'Eko Wahyudi', 'Fadli Akbar',
            'Fatimah Zahra', 'Galih Pratama', 'Hesti Wulandari', 'Irfan Maulana', 'Jihan Aulia',
            'Kamilah Nur', 'Lukman Hakim', 'Maya Safitri', 'Muhammad Rizki', 'Nabila Syakira',
            'Oki Setiawan', 'Putri Amalia', 'Rafli Ramadhan', 'Rina Marlina', 'Satria Bagaskara',
            'Siti Nurhaliza', 'Tegar Pamungkas', 'Umi Kalsum', 'Vano Alfarezi', 'Wahyudi Santoso',
            'Xenia Clarissa', 'Yusuf Al-Faruq', 'Zahra Salsabila', 'Aldi Pratama', 'Bella Safira'
        ];
        const kelasList = ['XI TKJ 1', 'XI TKJ 2', 'XI TKJ 3', 'X TKJ 1'];
        const stmt = db.prepare('INSERT INTO students (id, name, kelas) VALUES (?, ?, ?)');
        names.forEach((name, i) => stmt.run(String(2501 + i), name, kelasList[i % kelasList.length]));
        await new Promise((resolve, reject) => stmt.finalize((err) => err ? reject(err) : resolve()));

        // Sebar siswa ke ekskul (Volly dikecualikan — khusus roster murid asli)
        const ekskulRows = (await all('SELECT id, name FROM ekskul ORDER BY id'))
            .filter(e => e.name !== 'Volly');
        const memberStmt = db.prepare('INSERT OR IGNORE INTO ekskul_members (ekskul_id, student_id) VALUES (?, ?)');
        for (let i = 0; i < names.length; i++) {
            const studentId = String(2501 + i);
            memberStmt.run(ekskulRows[i % ekskulRows.length].id, studentId);
            if (i % 3 === 0) {
                memberStmt.run(ekskulRows[(i + 2) % ekskulRows.length].id, studentId);
            }
        }
        await new Promise((resolve, reject) => memberStmt.finalize((err) => err ? reject(err) : resolve()));
        console.log('35 siswa + keanggotaan ekskul berhasil di-seed.');
    }

    // --- Seed anggota ekskul Volly (roster murid asli, per kelas) ---
    const volly = await get("SELECT id FROM ekskul WHERE name = 'Volly'");
    if (volly) {
        const { c: vollyMemberCount } = await get(
            'SELECT COUNT(*) AS c FROM ekskul_members WHERE ekskul_id = ?', [volly.id]
        );
        if (vollyMemberCount === 0) {
            const roster = [
                ['X TKJ 1', ['Ahmad Sholahuddin Miqraj', 'Hafizh Faeyza', 'Haikal Bima Fajri']],
                ['X TKJ 2', ['Rafa Anandhia Jayakarta', 'Yusuf Romadhon', 'Zidan Al Farisy']],
                ['X TPTU 1', ['Daffa Iqbal Firmansyah', 'Mohamad Pandu']],
                ['X TPTU 2', ['Ridho Chaerul Fajri', 'Zulfan Arya Alfalah']],
                ['X TKR 1', ['Adi Firmansyah', 'Adira', 'Ahmad Rabsi Syaifulloh', 'Alfino Syahputra Wijaya', 'Andi Raffa Al Khan', 'Bimo Raditya Firmansyah']],
                ['X TKR 2', ['Hafizh Ridwan Santoso']],
                ['X TKR 3', ['Mahmud Afriyanto', 'Mohamad Deriansyah', 'Muhammad Yusuf Uzaman', 'Nabil Mubarok Harahap', 'Nabil Sakha Kurniawan']],
                ['X TKR 4', ['Rasya Dwi Kusuma', 'Richard Erick']],
                ['XI TKJ 1', ['Ahmad Ziyad Mustafid', 'Azka Reihandrian', 'Dimas Pratama Putra', 'Fahtur Rohman Rajak', 'Haidar Ali', 'Muhamad Sahlan', 'Septiansyah Ramadhani']],
                ['XI TKJ 2', ['Ibrahim Ilham Saputra', 'M. Badar Abiyyi']],
                ['XI TKR 1', ['Sandy Alvian']],
                ['XI TKR 2', ['M. Rizqi Syaputra', 'Rifqi Pratama', 'Umar Khadafi Ar-Rahman']],
                ['XI TKR 3', ['Rahmat Fajar S.', 'Ridzki Aldiyansyah', 'Rizaldi Firdaus']]
            ];

            // Reuse siswa yang sudah terdaftar (nama+kelas sama), sisanya ID baru
            const existing = await all('SELECT id, name, kelas FROM students');
            const byKey = new Map(existing.map(s =>
                [`${s.name.toLowerCase()}|${s.kelas.toLowerCase()}`, s.id]));
            const maxRow = await get('SELECT MAX(CAST(id AS INTEGER)) AS maxId FROM students');
            let nextId = (maxRow && maxRow.maxId ? maxRow.maxId : 2500) + 1;

            const sStmt = db.prepare('INSERT INTO students (id, name, kelas) VALUES (?, ?, ?)');
            const mStmt = db.prepare('INSERT OR IGNORE INTO ekskul_members (ekskul_id, student_id) VALUES (?, ?)');
            let added = 0;
            for (const [kelas, murid] of roster) {
                for (const name of murid) {
                    const key = `${name.toLowerCase()}|${kelas.toLowerCase()}`;
                    let id = byKey.get(key);
                    if (!id) {
                        id = String(nextId++);
                        sStmt.run(id, name, kelas);
                        byKey.set(key, id);
                    }
                    mStmt.run(volly.id, id);
                    added++;
                }
            }
            await new Promise((resolve, reject) => sStmt.finalize((err) => err ? reject(err) : resolve()));
            await new Promise((resolve, reject) => mStmt.finalize((err) => err ? reject(err) : resolve()));
            console.log(`${added} anggota ekskul Volly berhasil di-seed.`);
        }
    }
}

const ready = initDb().catch((err) => {
    console.error('Gagal inisialisasi database:', err.message);
    throw err;
});

// Tunggu inisialisasi DB sebelum proses request
app.use((req, res, next) => {
    ready.then(() => next()).catch(() => res.status(500).json({ success: false, error: 'Database belum siap' }));
});

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
async function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ success: false, message: 'Belum login' });

    const row = await get(
        `SELECT u.id, u.username, u.name, u.role, u.ekskul_id, e.name AS ekskul_name, s.expires_at
         FROM sessions s
         JOIN users u ON u.id = s.user_id
         LEFT JOIN ekskul e ON e.id = u.ekskul_id
         WHERE s.token = ?`,
        [token]
    );
    if (!row) return res.status(401).json({ success: false, message: 'Sesi tidak valid, silakan login ulang' });
    if (new Date(row.expires_at) < new Date()) {
        await run('DELETE FROM sessions WHERE token = ?', [token]);
        return res.status(401).json({ success: false, message: 'Sesi berakhir, silakan login ulang' });
    }
    req.user = row;
    req.token = token;
    next();
}

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Hanya admin yang boleh melakukan aksi ini' });
    }
    next();
}

// ---------------------------------------------------------------------------
// API: Autentikasi
// ---------------------------------------------------------------------------
app.post('/api/login', wrap(async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Username dan password wajib diisi' });
    }

    const user = await get(
        `SELECT u.*, e.name AS ekskul_name FROM users u
         LEFT JOIN ekskul e ON e.id = u.ekskul_id
         WHERE u.username = ?`,
        [username]
    );
    if (!user || !verifyPassword(password, user.password_hash)) {
        return res.status(401).json({ success: false, message: 'Username atau password salah!' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600 * 1000).toISOString();
    await run('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)', [token, user.id, expiresAt]);

    res.json({ success: true, token, user: publicUser(user) });
}));

app.post('/api/logout', requireAuth, wrap(async (req, res) => {
    await run('DELETE FROM sessions WHERE token = ?', [req.token]);
    res.json({ success: true, message: 'Berhasil logout' });
}));

app.get('/api/me', requireAuth, (req, res) => {
    res.json({ success: true, user: publicUser(req.user) });
});

// ---------------------------------------------------------------------------
// API: Ekskul
// ---------------------------------------------------------------------------
app.get('/api/ekskul', requireAuth, wrap(async (req, res) => {
    const base = `SELECT e.*,
        (SELECT COUNT(*) FROM ekskul_members m WHERE m.ekskul_id = e.id) AS member_count
        FROM ekskul e`;
    const rows = req.user.role === 'admin'
        ? await all(`${base} ORDER BY e.name`)
        : await all(`${base} WHERE e.id = ?`, [req.user.ekskul_id]);
    res.json(rows);
}));

app.post('/api/ekskul', requireAuth, requireAdmin, wrap(async (req, res) => {
    const { name, schedule_day, schedule_time } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ success: false, message: 'Nama ekskul wajib diisi' });
    }
    const info = await run(
        'INSERT INTO ekskul (name, schedule_day, schedule_time) VALUES (?, ?, ?)',
        [name.trim(), schedule_day || '', schedule_time || '']
    );
    res.json({ success: true, id: info.lastID, message: `Ekskul "${name.trim()}" berhasil ditambahkan` });
}));

app.delete('/api/ekskul/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    await run('BEGIN TRANSACTION');
    try {
        await run('DELETE FROM attendance WHERE ekskul_id = ?', [id]);
        await run('DELETE FROM ekskul_members WHERE ekskul_id = ?', [id]);
        await run('UPDATE users SET ekskul_id = NULL WHERE ekskul_id = ?', [id]);
        await run('DELETE FROM ekskul WHERE id = ?', [id]);
        await run('COMMIT');
        res.json({ success: true, message: 'Ekskul beserta datanya berhasil dihapus' });
    } catch (err) {
        await run('ROLLBACK');
        throw err;
    }
}));

// Anggota ekskul
app.get('/api/ekskul/:id/members', requireAuth, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!canAccessEkskul(req.user, id)) {
        return res.status(403).json({ success: false, message: 'Anda tidak punya akses ke ekskul ini' });
    }
    const rows = await all(
        `SELECT s.id, s.name, s.kelas, m.joined_at
         FROM ekskul_members m JOIN students s ON s.id = m.student_id
         WHERE m.ekskul_id = ?
         ORDER BY s.kelas COLLATE NOCASE, s.name COLLATE NOCASE`,
        [id]
    );
    res.json(rows);
}));

app.post('/api/ekskul/:id/members', requireAuth, requireAdmin, wrap(async (req, res) => {
    const ekskulId = Number(req.params.id);
    const { student_id: rawStudentId, name, kelas } = req.body;
    if (!rawStudentId) return res.status(400).json({ success: false, message: 'Siswa wajib dipilih' });
    const student_id = String(rawStudentId).trim();

    let student = await get('SELECT * FROM students WHERE id = ?', [student_id]);
    if (!student) {
        // Belum terdaftar: buat data siswa baru langsung dari form
        if (!name || !name.trim()) {
            return res.status(400).json({ success: false, message: 'Siswa belum terdaftar, isi nama dan kelasnya' });
        }
        await run('INSERT INTO students (id, name, kelas) VALUES (?, ?, ?)', [student_id, name.trim(), (kelas || '').trim()]);
    }

    const existing = await get('SELECT id FROM ekskul_members WHERE ekskul_id = ? AND student_id = ?', [ekskulId, student_id]);
    if (existing) {
        return res.status(409).json({ success: false, message: 'Siswa sudah menjadi anggota ekskul ini' });
    }
    await run('INSERT INTO ekskul_members (ekskul_id, student_id) VALUES (?, ?)', [ekskulId, student_id]);
    res.json({ success: true, message: 'Anggota berhasil ditambahkan' });
}));

app.delete('/api/ekskul/:id/members/:studentId', requireAuth, requireAdmin, wrap(async (req, res) => {
    await run('DELETE FROM ekskul_members WHERE ekskul_id = ? AND student_id = ?',
        [Number(req.params.id), String(req.params.studentId)]);
    res.json({ success: true, message: 'Anggota berhasil dihapus dari ekskul' });
}));

// ---------------------------------------------------------------------------
// API: Siswa
// ---------------------------------------------------------------------------
app.get('/api/students', requireAuth, requireAdmin, wrap(async (req, res) => {
    const rows = await all(
        `SELECT s.*,
            (SELECT COUNT(*) FROM ekskul_members m WHERE m.student_id = s.id) AS ekskul_count
         FROM students s ORDER BY s.kelas COLLATE NOCASE, s.name COLLATE NOCASE`
    );
    res.json(rows);
}));

// Tambah siswa: NIS tidak wajib — ID internal auto-generated
app.post('/api/students', requireAuth, requireAdmin, wrap(async (req, res) => {
    const { name, kelas } = req.body;
    if (!name || !name.trim()) {
        return res.status(400).json({ success: false, message: 'Nama siswa wajib diisi' });
    }
    // ID = max ID numerik saat ini + 1 (fallback ke timestamp)
    const row = await get('SELECT MAX(CAST(id AS INTEGER)) AS maxId FROM students');
    const newId = row && row.maxId ? String(row.maxId + 1) : String(Date.now());
    await run('INSERT INTO students (id, name, kelas) VALUES (?, ?, ?)', [newId, name.trim(), (kelas || '').trim()]);
    res.json({ success: true, id: newId, message: 'Siswa berhasil ditambahkan' });
}));

// ---------------------------------------------------------------------------
// API: Absensi
// ---------------------------------------------------------------------------
app.get('/api/attendance/:ekskulId/history', requireAuth, wrap(async (req, res) => {
    const ekskulId = Number(req.params.ekskulId);
    if (!canAccessEkskul(req.user, ekskulId)) {
        return res.status(403).json({ success: false, message: 'Anda tidak punya akses ke ekskul ini' });
    }
    const rows = await all(
        `SELECT date,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'Hadir' THEN 1 ELSE 0 END) AS hadir
         FROM attendance
         WHERE ekskul_id = ?
         GROUP BY date
         ORDER BY date DESC`,
        [ekskulId]
    );
    res.json(rows);
}));

app.get('/api/attendance/:ekskulId/:date', requireAuth, wrap(async (req, res) => {
    const ekskulId = Number(req.params.ekskulId);
    const { date } = req.params;
    if (!canAccessEkskul(req.user, ekskulId)) {
        return res.status(403).json({ success: false, message: 'Anda tidak punya akses ke ekskul ini' });
    }
    const rows = await all(
        `SELECT a.student_id, a.status, a.note, s.name
         FROM attendance a JOIN students s ON s.id = a.student_id
         WHERE a.ekskul_id = ? AND a.date = ?
         ORDER BY s.kelas COLLATE NOCASE, s.name COLLATE NOCASE`,
        [ekskulId, date]
    );
    res.json(rows);
}));

app.post('/api/attendance', requireAuth, wrap(async (req, res) => {
    const { ekskul_id, date, note, attendance } = req.body;

    if (!ekskul_id || !date || !Array.isArray(attendance)) {
        return res.status(400).json({ success: false, message: 'Data tidak lengkap' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ success: false, message: 'Format tanggal tidak valid' });
    }
    if (!canAccessEkskul(req.user, Number(ekskul_id))) {
        return res.status(403).json({ success: false, message: 'Anda tidak punya akses ke ekskul ini' });
    }

    // Pastikan semua siswa yang dikirim adalah anggota ekskul tersebut
    const memberIds = new Set(
        (await all('SELECT student_id FROM ekskul_members WHERE ekskul_id = ?', [ekskul_id])).map(r => r.student_id)
    );
    for (const item of attendance) {
        if (!STATUS_ALLOWED.includes(item.status)) {
            return res.status(400).json({ success: false, message: `Status "${item.status}" tidak valid` });
        }
        if (!memberIds.has(String(item.student_id))) {
            return res.status(400).json({ success: false, message: `Siswa ${item.student_id} bukan anggota ekskul ini` });
        }
    }

    await run('BEGIN TRANSACTION');
    try {
        const stmt = `INSERT INTO attendance (ekskul_id, date, student_id, status, note, recorded_by)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(ekskul_id, date, student_id)
            DO UPDATE SET status = excluded.status, note = excluded.note, recorded_by = excluded.recorded_by`;
        for (const item of attendance) {
            await run(stmt, [ekskul_id, date, String(item.student_id), item.status, note || '', req.user.id]);
        }
        await run('COMMIT');
        res.json({ success: true, message: 'Absensi berhasil disimpan!' });
    } catch (err) {
        await run('ROLLBACK');
        throw err;
    }
}));

// ---------------------------------------------------------------------------
// API: Pengguna (hanya admin)
// ---------------------------------------------------------------------------
app.get('/api/users', requireAuth, requireAdmin, wrap(async (req, res) => {
    const rows = await all(
        `SELECT u.id, u.username, u.name, u.role, u.ekskul_id, u.created_at, e.name AS ekskul_name
         FROM users u LEFT JOIN ekskul e ON e.id = u.ekskul_id
         ORDER BY u.role, u.username`
    );
    res.json(rows);
}));

app.post('/api/users', requireAuth, requireAdmin, wrap(async (req, res) => {
    const { username, password, name, role, ekskul_id } = req.body;
    if (!username || !password || !name || !name.trim()) {
        return res.status(400).json({ success: false, message: 'Username, password, dan nama wajib diisi' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'Password minimal 6 karakter' });
    }
    if (!['admin', 'pembina'].includes(role)) {
        return res.status(400).json({ success: false, message: 'Role tidak valid' });
    }
    if (role === 'pembina' && !ekskul_id) {
        return res.status(400).json({ success: false, message: 'Pembina harus ditugaskan ke satu ekskul' });
    }

    const existing = await get('SELECT id FROM users WHERE username = ?', [username.trim()]);
    if (existing) return res.status(409).json({ success: false, message: 'Username sudah dipakai' });

    await run(
        'INSERT INTO users (username, password_hash, name, role, ekskul_id) VALUES (?, ?, ?, ?, ?)',
        [username.trim(), hashPassword(password), name.trim(), role, role === 'pembina' ? ekskul_id : null]
    );
    res.json({ success: true, message: 'Akun berhasil dibuat' });
}));

app.delete('/api/users/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) {
        return res.status(400).json({ success: false, message: 'Tidak bisa menghapus akun sendiri' });
    }
    await run('DELETE FROM sessions WHERE user_id = ?', [id]);
    await run('DELETE FROM users WHERE id = ?', [id]);
    res.json({ success: true, message: 'Akun berhasil dihapus' });
}));

// ---------------------------------------------------------------------------
// Jalankan server (lokal) — Vercel memakai api/index.js
// ---------------------------------------------------------------------------
if (require.main === module) {
    ready.then(() => {
        app.listen(PORT, () => {
            console.log(`Server berjalan di http://localhost:${PORT}`);
        });
    });
}

module.exports = app;
