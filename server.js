const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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

// Buat Tabel Siswa, Absensi, dan Users (Admin/Guru)
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS students (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS attendance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date TEXT NOT NULL,
        student_id TEXT NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        FOREIGN KEY(student_id) REFERENCES students(id)
    )`);

    // Satu baris absensi per siswa per tanggal
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_attendance_date_student
            ON attendance(date, student_id)`);

    // Seed Akun Default (Admin / Guru)
    db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
        if (row.count === 0) {
            db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", ['admin', 'admin123', 'admin']);
            db.run("INSERT INTO users (username, password, role) VALUES (?, ?, ?)", ['guru', 'guru123', 'teacher']);
            console.log("Akun default dibuat: admin / admin123 & guru / guru123");
        }
    });

    // Seed Data 35 Murid jika kosong
    db.get("SELECT COUNT(*) as count FROM students", (err, row) => {
        if (row.count === 0) {
            const initialStudents = [
                { id: "2501", name: "Ahmad Fauzi" },
                { id: "2502", name: "Anisa Rahmawati" },
                { id: "2503", name: "Arya Saputra" },
                { id: "2504", name: "Aurel Putri" },
                { id: "2505", name: "Bima Prasetyo" },
                { id: "2506", name: "Cika Melania" },
                { id: "2507", name: "Danuarta Pratama" },
                { id: "2508", name: "Dinda Kirana" },
                { id: "2509", name: "Eko Wahyudi" },
                { id: "2510", name: "Fadli Akbar" },
                { id: "2511", name: "Fatimah Zahra" },
                { id: "2512", name: "Galih Pratama" },
                { id: "2513", name: "Hesti Wulandari" },
                { id: "2514", name: "Irfan Maulana" },
                { id: "2515", name: "Jihan Aulia" },
                { id: "2516", name: "Kamilah Nur" },
                { id: "2517", name: "Lukman Hakim" },
                { id: "2518", name: "Maya Safitri" },
                { id: "2519", name: "Muhammad Rizki" },
                { id: "2520", name: "Nabila Syakira" },
                { id: "2521", name: "Oki Setiawan" },
                { id: "2522", name: "Putri Amalia" },
                { id: "2523", name: "Rafli Ramadhan" },
                { id: "2524", name: "Rina Marlina" },
                { id: "2525", name: "Satria Bagaskara" },
                { id: "2526", name: "Siti Nurhaliza" },
                { id: "2527", name: "Tegar Pamungkas" },
                { id: "2528", name: "Umi Kalsum" },
                { id: "2529", name: "Vano Alfarezi" },
                { id: "2530", name: "Wahyudi Santoso" },
                { id: "2531", name: "Xenia Clarissa" },
                { id: "2532", name: "Yusuf Al-Faruq" },
                { id: "2533", name: "Zahra Salsabila" },
                { id: "2534", name: "Aldi Taher" },
                { id: "2535", name: "Bella Safira" }
            ];

            const stmt = db.prepare("INSERT INTO students (id, name) VALUES (?, ?)");
            initialStudents.forEach(s => {
                stmt.run(s.id, s.name);
            });
            stmt.finalize();
            console.log("35 Data murid berhasil di-seed.");
        }
    });
});

// API Routes
// 1. Login Endpoint
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get("SELECT * FROM users WHERE username = ? AND password = ?", [username, password], (err, row) => {
        if (err) {
            return res.status(500).json({ success: false, message: "Terjadi kesalahan server" });
        }
        if (row) {
            res.json({ success: true, user: { username: row.username, role: row.role } });
        } else {
            res.status(401).json({ success: false, message: "Username atau password salah!" });
        }
    });
});

// 2. Ambil daftar murid
app.get('/api/students', (req, res) => {
    db.all("SELECT * FROM students", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json(rows);
    });
});

// 3. Simpan absensi (upsert per tanggal, dalam satu transaksi)
app.post('/api/attendance', (req, res) => {
    const { date, attendance, note } = req.body;

    if (!date || !Array.isArray(attendance)) {
        return res.status(400).json({ success: false, error: "Data tidak lengkap" });
    }

    db.serialize(() => {
        db.run("BEGIN TRANSACTION");
        db.run("DELETE FROM attendance WHERE date = ?", [date], (err) => {
            if (err) console.error("Gagal menghapus data lama:", err.message);
        });

        const stmt = db.prepare("INSERT INTO attendance (date, student_id, status, note) VALUES (?, ?, ?, ?)");
        attendance.forEach(item => {
            stmt.run(date, item.student_id, item.status, note || '');
        });

        stmt.finalize((err) => {
            if (err) {
                db.run("ROLLBACK");
                return res.status(500).json({ success: false, error: err.message });
            }
            db.run("COMMIT", (commitErr) => {
                if (commitErr) {
                    db.run("ROLLBACK");
                    return res.status(500).json({ success: false, error: commitErr.message });
                }
                res.json({ success: true, message: "Absensi berhasil disimpan!" });
            });
        });
    });
});

// 4. Muat absensi berdasarkan tanggal
app.get('/api/attendance/:date', (req, res) => {
    const { date } = req.params;
    db.all(
        "SELECT student_id, status, note FROM attendance WHERE date = ? ORDER BY student_id",
        [date],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// 5. Riwayat tanggal yang sudah diisi beserta ringkasannya
app.get('/api/attendance', (req, res) => {
    db.all(
        `SELECT date,
                COUNT(*) AS total,
                SUM(CASE WHEN status = 'Hadir' THEN 1 ELSE 0 END) AS hadir
         FROM attendance
         GROUP BY date
         ORDER BY date DESC`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// Hanya jalankan server saat dijalankan langsung (bukan saat di-import Vercel)
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server berjalan di http://localhost:${PORT}`);
    });
}

module.exports = app;
