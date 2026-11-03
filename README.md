# Мафия онлайн

Har bir o'yinchi o'z telefonidan kiradigan Mafia o'yini. Host (boshlovchi) xona yaratadi, taklif linkini yoki QR-kodni ulashadi. O'yinchilar linkni ochib, ismini kiritadi. Hamma yig'ilgach host o'yinni boshlaydi va har kim faqat o'z rolini ko'radi.

Server kerak emas: sayt GitHub Pages'da ishlaydi. Eski bitta telefonli versiya `offline.html` da saqlangan.

## GitHub Pages'ga joylash

1. Repo → **Settings → Pages**.
2. **Source**: *Deploy from a branch*. Branch: kod turgan branch, papka: `/ (root)`. **Save**.
3. Bir-ikki daqiqadan keyin sayt `https://<login>.github.io/MafiyaGame/` manzilida ochiladi.

Bepul GitHub hisobida Pages faqat **public** repolarda ishlaydi.

## Qanday ishlaydi

1. Host **«Создать игру»** ni bosadi. 5 belgili xona kodi, link (`?room=KOD`) va QR-kod chiqadi.
2. O'yinchilar linkni ochadi yoki kodni qo'lda kiritadi, ismini yozadi va kutish xonasiga tushadi. Host ro'yxatni jonli ko'radi va kerak bo'lsa o'yinchini chiqaradi.
3. Kamida 5 kishi bo'lganda host o'yinni boshlaydi. Har bir telefonga faqat uning roli yuboriladi:
   - mafiya va don o'z jamoasini ko'radi;
   - detektiv yordamchisi detektivni ko'radi;
   - hamshira doktorni ko'radi.
4. Host o'z telefonida kecha va kunni yuritadi. O'lganlar, kecha/kun va g'olib hamma telefonlarda ko'rinadi. Jurnal faqat hostda.
5. **O'yinchilar amalni telefondan tanlaydi** (rolni ochganda ko'rinadi):
   - kechasi: mafiya qurbon tanlaydi (don bo'lsa, uning tanlovi hal qiladi, jamoa bir-birining tanlovini ko'radi), don detektivni qidiradi, detektiv (u chiqsa yordamchi) tekshiradi, doktor (u chiqsa hamshira) davolaydi, manyak o'ldiradi, ma'shuqa chalg'itadi. Tinch aholining kechki amali yo'q;
   - kunduzi: har bir tirik o'yinchi kimni chiqarishga ovoz beradi;
   - host har bir tanlovni jonli ko'radi («📱 Ism → Nishon»), ular kecha formasiga va ovozlar soniga o'zi tushadi, host qo'lda o'zgartira oladi;
   - detektiv va donning tekshiruv natijasi ertalab faqat ularning telefoniga keladi;
   - doktor o'zini faqat bir marta davolay oladi, ma'shuqa bir odamni ketma-ket ikki kecha tanlay olmaydi.
6. Sahifa yangilansa, o'yinchi ham, host ham avtomatik qaytadi (`localStorage`).

### Texnik tomoni

- O'yin serveri yo'q. **Xona hostning brauzerida yashaydi**, o'yinchilar unga to'g'ridan-to'g'ri WebRTC (PeerJS) orqali ulanadi.
- Bir-birini topish uchun bepul ochiq PeerJS serveri (`0.peerjs.com`) ishlatiladi. U faqat ulanishni o'rnatadi, o'yin ma'lumotlari u orqali o'tmaydi.
- Shuning uchun **host sahifasi o'yin davomida ochiq turishi kerak**. Ekran o'chmasligi uchun Wake Lock yoqiladi. Host sahifani yangilasa, o'yin saqlanib qoladi va o'yinchilar o'zi qayta ulanadi.
- Ba'zi mobil operatorlar tarmog'ida WebRTC ulanmasligi mumkin (TURN server yo'q). Bunday holda hamma bitta Wi-Fi'ga ulansa ishonchli ishlaydi.
- O'z PeerJS serveringizdan foydalanish uchun sahifa skriptidan oldin `window.MAFIA_PEER = {host, port, path, secure}` ni belgilang.

## Lokal ishga tushirish

```bash
npm start   # http://localhost:3000 (statik server)
npm test    # o'yin mantig'i testlari
```

## Tuzilma

| Fayl | Vazifasi |
|---|---|
| `index.html` | Onlayn o'yin: bosh sahifa, o'yinchi va host ekranlari, PeerJS tarmoq qismi |
| `room.js` | Xona qoidalari: qo'shilish, rollar, kim nimani ko'rishi (hostda ishlaydi) |
| `roles.js` | Rollar va tarkib |
| `offline.html` | Asl bitta telefonli versiya |
| `vendor/` | PeerJS 1.5.5 va qrcode-generator 1.4.4 (CDN'ga bog'liq bo'lmaslik uchun) |
| `test/` | `node --test` testlari |
