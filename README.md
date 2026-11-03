# Мафия онлайн

Har bir o'yinchi o'z telefonidan kiradigan Mafia o'yini. Host (boshlovchi) xona yaratadi, taklif linkini yoki QR-kodni ulashadi. O'yinchilar linkni ochib, ismini kiritadi. Hamma yig'ilgach host o'yinni boshlaydi va har kim faqat o'z rolini ko'radi.

Server kerak emas: sayt GitHub Pages'da ishlaydi. Eski bitta telefonli versiya `offline.html` da saqlangan.

Interfeys **o'zbekcha va ruscha**. Tepadagi UZ / RU tugmasi tilni almashtiradi, tanlov telefonda eslab qolinadi. Har bir o'yinchi o'z tilini tanlaydi: rollar, natijalar va xatolar har bir telefonda o'z tilida ko'rinadi.

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
6. **Botlar.** Lobbida host «🤖 Bot qo'shish» bilan bot qo'shadi (odam yetmasa yoki sinash uchun). Botlar host telefonida ishlaydi va o'zi o'ynaydi:
   - mafiya botlari donning (yoki jamoadoshning) tanloviga qo'shiladi, o'z jamoasiga hujum qilmaydi, don topgan detektivni yoki kechagi kunda mafiyaga ovoz berganlarni nishonga oladi;
   - detektiv va don botlari tekshirilmagan odamlarni tekshiradi va natijani eslab qoladi; detektiv topgan mafiyaga ovoz beradi;
   - doktor ko'p ovoz olgan odamni himoya qiladi, o'zini bir marta davolashi mumkin;
   - kunduzi botlar aniq yetakchiga qo'shiladi, mafiya botlari esa ko'pchilikka qo'shilib o'zini yashiradi;
   - botlar odamga o'xshab bir necha soniya o'ylab yuradi.
7. Sahifa yangilansa, o'yinchi ham, host ham avtomatik qaytadi (`localStorage`).

### Texnik tomoni

- O'yin serveri yo'q. **Xona hostning brauzerida yashaydi.** O'yinchilar unga bepul ochiq MQTT brokerlari orqali (oddiy WSS, WebRTC emas) xabar yuboradi: `broker.emqx.io`, `broker.hivemq.com`, `test.mosquitto.org`.
- Host ulana oladigan barcha brokerlarni tinglaydi, har bir o'yinchi esa o'zida ishlaydigan birinchisidan foydalanadi. Bitta broker ishlamasa, boshqasi orqali ulanadi.
- Barcha xabarlar shifrlangan (ECDH P-256 + AES-GCM): brokerni kuzatgan odam rollarni ko'ra olmaydi.
- **Host sahifasi o'yin davomida ochiq turishi kerak.** Ekran o'chmasligi uchun Wake Lock yoqiladi. Host sahifani yangilasa, o'yin saqlanib qoladi va o'yinchilar o'zi qayta ulanadi.
- Brokerlar ro'yxatini almashtirish uchun sahifa skriptidan oldin `window.MAFIA_MQTT = ["wss://..."]` ni belgilang.

## Lokal ishga tushirish

```bash
npm start   # http://localhost:3000 (statik server)
npm test    # o'yin mantig'i testlari
```

## Tuzilma

| Fayl | Vazifasi |
|---|---|
| `index.html` | Onlayn o'yin: bosh sahifa, o'yinchi va host ekranlari, MQTT tarmoq qismi |
| `room.js` | Xona qoidalari: qo'shilish, rollar, kim nimani ko'rishi (hostda ishlaydi) |
| `roles.js` | Rollar va tarkib |
| `bots.js` | Botlar «miyasi»: rolga qarab tanlov va ovoz |
| `i18n.js` | O'zbekcha va ruscha matnlar (`t(kalit)`) |
| `offline.html` | Asl bitta telefonli versiya |
| `vendor/` | mqtt.js 5.10.4 va qrcode-generator 1.4.4 (CDN'ga bog'liq bo'lmaslik uchun) |
| `test/` | `node --test` testlari |
