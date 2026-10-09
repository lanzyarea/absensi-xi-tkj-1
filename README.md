# Aplikasi Absensi Kelas XI TKJ 1

Aplikasi absensi fullstack (tanpa template) untuk kelas **XI TKJ 1** dengan 35 murid.

**Tech stack:**
- **Backend:** Node.js + Express + SQLite3
- **Frontend:** HTML vanilla + Tailwind CSS (CDN) + Font Awesome
- **Auth:** Sistem login sederhana (validasi ke database)

## Menjalankan Secara Lokal

```bash
npm install
npm start
```

Buka `http://localhost:3000`

> Saat pertama dijalankan, database `absensi.db` akan dibuat otomatis dan
> diisi 35 data murid + 2 akun login.

## Akun Login

| Role  | Username | Password   |
|-------|----------|------------|
| Admin | `admin`  | `admin123` |
| Guru  | `guru`   | `guru123`  |

## API Endpoint

| Method | Endpoint                | Fungsi                                  |
|--------|-------------------------|-----------------------------------------|
| POST   | `/api/login`            | Login (username, password)              |
| GET    | `/api/students`         | Daftar 35 murid                         |
| POST   | `/api/attendance`       | Simpan absensi tanggal tertentu         |
| GET    | `/api/attendance/:date` | Muat absensi berdasarkan tanggal        |
| GET    | `/api/attendance`       | Riwayat tanggal yang sudah diisi        |

## Deploy ke GitHub + Vercel

```bash
git init
git add .
git commit -m "Absensi XI TKJ 1"
git branch -M main
git remote add origin https://github.com/USERNAME/REPO.git
git push -u origin main
```

Kemudian di [vercel.com](https://vercel.com): **Import Project** → pilih
repository → **Deploy**. Konfigurasi sudah tersedia di `vercel.json`.

### ⚠️ Catatan Penting tentang Database di Vercel

Vercel adalah platform *serverless* dengan filesystem **read-only**
(hanya `/tmp` yang bisa ditulis, dan itu **bersifat sementara**).
Artinya data absensi yang disimpan dengan SQLite di Vercel **bisa hilang
saat instance server di-reset**.

- **Untuk penggunaan nyata / data permanen**, gunakan database cloud:
  - [Turso](https://turso.tech) (gratis, kompatibel SQLite, tinggal ganti driver)
  - [Vercel Postgres / Neon](https://neon.tech)
  - Host sendiri (Railway / Render) yang mendukung filesystem persisten

Untuk demo/pengujian, SQLite di Vercel masih berfungsi selama instance aktif.
