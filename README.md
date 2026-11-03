# Мафия онлайн

Har bir o'yinchi o'z telefonidan kiradigan Mafia o'yini. Host (boshlovchi) xona yaratadi, taklif linkini yoki QR-kodni ulashadi. O'yinchilar linkni ochib, ismini kiritadi. Hamma yig'ilgach host o'yinni boshlaydi va har kim faqat o'z rolini ko'radi.

Eski bitta telefonli versiya `/offline.html` manzilida saqlangan.

## Ishga tushirish

```bash
npm install
npm start        # http://localhost:3000
npm test
```

`PORT` muhit o'zgaruvchisi portni o'zgartiradi.

## Qanday ishlaydi

1. Host bosh sahifada **«Создать игру»** ni bosadi. 5 belgili xona kodi, link (`/?room=KOD`) va QR-kod chiqadi.
2. O'yinchilar linkni ochadi yoki kodni qo'lda kiritadi, ismini yozadi va kutish xonasiga tushadi. Host ro'yxatni jonli ko'radi va kerak bo'lsa o'yinchini chiqarib yuboradi.
3. Kamida 5 kishi bo'lganda host o'yinni boshlaydi. Server rollarni tarqatadi va har bir telefonga faqat uning rolini yuboradi:
   - mafiya va don o'z jamoasini ko'radi;
   - detektiv yordamchisi detektivni ko'radi;
   - hamshira doktorni ko'radi.
4. Host o'z telefonida kecha va kunni yuritadi. O'lganlar, kecha/kun va g'olib hamma telefonlarda ko'rinadi. Jurnal (detektiv tekshiruvlari va h.k.) faqat hostda.
5. Sahifa yangilansa yoki telefon uxlab qolsa, o'yinchi va host avtomatik qaytadi (token `localStorage` da).
6. O'yin boshlangach yangi o'yinchi qo'shila olmaydi. «Вернуться в лобби» xonani qayta ochadi.

## Tuzilma

| Fayl | Vazifasi |
|---|---|
| `server.js` | Express + Socket.IO, voqealar, QR endpoint `/qr.svg` |
| `rooms.js` | Xonalar, qo'shilish, rollar, kim nimani ko'rishi (tarmoqdan mustaqil) |
| `public/roles.js` | Rollar va tarkib, server va brauzer uchun umumiy |
| `public/index.html` | Onlayn mijoz: bosh sahifa, o'yinchi va host ekranlari |
| `public/offline.html` | Asl bitta telefonli versiya |
| `test/` | `node --test` testlari |

Xonalar server xotirasida saqlanadi va 6 soat faol bo'lmasa o'chadi. Server qayta ishga tushsa, xonalar yo'qoladi.

## Internetga joylash

Doimiy ishlaydigan Node.js server kerak (WebSocket qo'llab-quvvatlashi bilan). Masalan Render.com: yangi **Web Service**, build `npm install`, start `npm start`. Railway, Fly.io yoki oddiy VPS ham mos keladi. Statik hosting (GitHub Pages, Netlify) ishlamaydi.
