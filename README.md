# Nyangkut — Landing Page

Landing page marketing untuk **Nyangkut**, web app pencatat uang yang masih "nyangkut" antar-orang.

> Core value: *"Biar nggak lupa uang lo masih nyangkut di mana."*

## Struktur

- `index.html` — satu halaman: navbar, hero, problem, solusi/fitur, showcase produk, use cases, cara kerja, CTA akhir, footer.
- `styles.css` — mobile-first, responsif (breakpoint 640px & 900px). Palet hijau diambil dari mockup produk.
- `script.js` — menu mobile, reveal-on-scroll, animasi counter. Tanpa dependency.
- `assets/` — screenshot mockup produk (dipakai di section showcase).

## Menjalankan lokal

Buka `index.html` langsung di browser, atau via server statis:

```bash
cd nyangkut
python3 -m http.server 8080
# buka http://localhost:8080
```

## Catatan produk (dari mockup, jadi source of truth)

- Nyangkut **bukan debt collector**: hanya membantu mencatat, mengingatkan, dan mengelola.
- Pengingat WhatsApp: teks disiapkan aplikasi, **user yang menekan Kirim** dari WhatsApp mereka sendiri. Tidak ada penagihan otomatis.
- Tidak ada payment gateway / accounting kompleks di versi ini.
- Fokus konversi: **Daftar / Coba Gratis**.

## Deploy

File statis — bisa langsung di-deploy ke Vercel, Netlify, GitHub Pages, atau hosting statis lainnya.
