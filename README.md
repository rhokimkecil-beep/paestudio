# PaeSTUDIO

Uploader aset Roblox (decal, audio, model) + konverter audio di browser.
Frontend statis di `public/`, backend serverless di `api/upload.js`.

## Struktur
```
public/index.html   -> halaman web (+ logo.png, favicon.png)
api/upload.js       -> endpoint POST /api/upload (Roblox Open Cloud)
vercel.json         -> maxDuration 30 detik
package.json        -> dependency formidable
```

## Deploy
**Lewat GitHub (disarankan)**
1. Push folder ini ke repo GitHub.
2. Di vercel.com: Add New > Project > pilih repo > Deploy. Tidak perlu setting tambahan.

**Lewat CLI**
```
npm i -g vercel
vercel --prod
```

## Cara pakai
1. Buat API key di Roblox Creator Hub > Open Cloud > API Keys.
   Beri permission **Assets: Read & Write** (sertakan experience/group yang sesuai).
2. Buka situs hasil deploy, isi API key, pilih User/Group, isi ID pemilik, lalu upload.

## Batasan
- Vercel membatasi body request sekitar **4,5 MB**, jadi file yang diupload maksimal ~4 MB.
  File audio besar sebaiknya dikonversi ke MP3 bitrate lebih rendah (konverter bawaan sudah ada).
- API key dikirim ke `/api/upload` hanya untuk diteruskan ke Roblox. Tidak disimpan dan tidak di-log.
- Upload ke Roblox diproses asinkron. Jika belum selesai dalam ~12 detik, halaman menampilkan
  status "diproses" dan aset bisa dicek di Creator Dashboard.
