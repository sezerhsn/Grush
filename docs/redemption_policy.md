# GRUSH Redemption Policy v0.1

> Bu politika, GRUSH tokenlarının itfa (redemption) sürecini normatif olarak tanımlar.  
> Teknik referanslar: `docs/core-spec_v0.1.md`, `docs/fee_model.md`, `contracts/src/RedemptionGateway.sol`  
> Uyum referansları: `compliance/*`, `legal/spv-trust/*`, `ops/vault/*`

Normatif anahtar kelimeler: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.

---

## 0. Amaç ve kapsam

Bu dokümanın amacı:

- GRUSH itfa sürecini uçtan uca netleştirmek
- Kullanıcıyı sürpriz ücret/süreç riskinden korumak
- Zincir üstü (on-chain) ve operasyonel (off-chain) adımları tek çatıya bağlamak
- Uyum (KYC/AML/sanctions) ve rezerv muhasebesi ile tutarlı bir çerçeve kurmak

Kapsam:

- Bireysel/kurumsal itfa başvuruları
- Fiziki itfa ve (uygulanırsa) nakit itfa
- Talep, inceleme, karar, teslimat/ödeme, kayıt ve ihtilaf yönetimi

---

## 1. Tanımlar

- **İtfa (Redemption):** GRUSH tokenının yakım karşılığında fiziksel altın veya nakit karşılığına çevrilmesi.
- **Request ID:** Her itfa talebinin zincir üstü benzersiz kimliği.
- **Destination Hash:** Kullanıcının teslim/ödeme bilgisinin hash referansı (PII zincire yazılmaz).
- **Escrow:** Talep edilen GRUSH miktarının gateway kontratında geçici tutulması.
- **Fulfillment:** İtfa talebinin operasyonel tamamlanması (teslimat/ödeme).
- **Business Day:** İlgili operasyon birimlerinin açık olduğu iş günü.

---

## 2. Yönetişim ve sorumluluklar

- **Operator (MUST):** İtfa taleplerini reddetme/tamamlama kararını verir.
- **Compliance (MUST):** KYC/KYB, AML, sanctions kontrollerini yapar.
- **Vault/Custody Ops (MUST):** Fiziki teslimat ve rezerv düşümünü yürütür.
- **Finance/Accounting (MUST):** Ücret, mutabakat ve kayıt doğruluğunu sağlar.
- **Security/Ops (MUST):** Şüpheli işlem, anahtar güvenliği ve olay yönetimi yapar.

Karar ayrımı ilkesi:
- Talep onayı, uyum kontrolü ve teslimat operasyonu tek kişide birleşmemelidir (segregation of duties).

---

## 3. Uygunluk ve müşteri kabulü

İtfa başvurusu için kullanıcı:

1. Kimlik/doğrulama süreçlerini tamamlamış olmalı (KYC/KYB)
2. Sanctions screening’den geçmiş olmalı
3. Talep edilen ülke/bölge için yasal kısıt ihlali taşımamalı
4. Gerekli sözleşme/onay metinlerini kabul etmiş olmalı

Aşağıdaki durumlarda başvuru reddedilebilir:

- Sahte/eksik bilgi
- Uyum risk skoru eşik üstü
- Yaptırım listesi eşleşmesi
- Dolandırıcılık şüphesi
- Hukuki kısıt/embargo

---

## 4. İtfa türleri

## 4.1 Fiziki itfa
- Kullanıcı GRUSH yakımı karşılığında fiziksel altın teslim alır.
- Teslimat modeli: kasadan teslim / yetkili lojistik ile sevk (operasyon politikasına bağlı).

## 4.2 Nakit itfa (opsiyonel)
- Uygulanıyorsa mevzuat, bankacılık erişimi ve operasyon kapasitesi sınırları içinde sunulur.
- Nakit itfa oran/kur dönüşümü ve ücretleri açıkça ilan edilir.

> Nakit itfa desteklenmiyorsa bu açıkça “sunulmuyor” olarak belirtilmelidir.

---

## 5. Minimum itfa, adım büyüklüğü, yuvarlama

Varsayılan politika (v0.1 başlangıç parametreleri):

- **Fiziki itfa minimumu:** 100 GRUSH
- **Nakit itfa minimumu:** 10 GRUSH
- **Adım büyüklüğü:** 1 GRUSH
- **Yuvarlama:** Aşağı yuvarlama yasak; talep miktarı geçerli adımda değilse talep reddedilir.

Bu parametreler değiştirilecekse:

- Değişiklikten önce kamuya açık duyuru yapılmalı
- Değişiklik tarihi ve gerekçe yayınlanmalı
- Eski talepler geriye dönük etkilenmemeli

---

## 6. Süreç akışı (on-chain + off-chain)

## 6.1 Talep oluşturma
- Kullanıcı `requestRedemption(amount, destinationHash)` çağırır
- Tokenlar gateway’de escrow’a alınır
- `RedemptionRequested` eventi yayınlanır
- Talep durumu: `Requested`

## 6.2 İnceleme
- Uyum kontrolleri yapılır (KYC/AML/sanctions)
- Operasyonel uygunluk (stok, lojistik, bölge) kontrol edilir

## 6.3 Karar
- **Red:** `rejectRedemption(requestId, reasonHash)`  
  - Escrow token kullanıcıya iade edilir
  - Durum: `Rejected`
- **Fulfill:** `fulfillRedemption(requestId, fulfillmentRef)`  
  - Escrow token yakılır
  - Durum: `Fulfilled`

## 6.4 Kullanıcı iptali
- Durum `Requested` iken kullanıcı `cancelRedemption(requestId)` çağırabilir
- Escrow token kullanıcıya iade edilir
- Durum: `Cancelled`

---

## 7. SLA (hizmet seviyeleri)

SLA saatleri “iş günü” üzerinden ölçülür:

- **Başvuru alındı bildirimi:** en geç 1 iş günü
- **Ön uygunluk/uyum sonucu:** en geç 2 iş günü
- **Nakit itfa tamamlanması (uygunsa):** 3 iş günü hedef
- **Fiziki itfa sevki/teslim hazırlığı:** 5–10 iş günü hedef (bölgeye göre)
- **Sınır ötesi sevk:** 10–20 iş günü hedef

SLA istisnaları:
- Resmî tatil, mücbir sebep, gümrük gecikmesi, zincir yoğunluğu, regülasyon kaynaklı beklemeler.

---

## 8. Ücret politikası (özet)

İtfa sırasında uygulanabilecek kalemler:

- Redemption processing fee
- Lojistik/teslimat maliyeti (fiziki itfada)
- Banka/ödeme kanalı masrafı (nakit itfada)
- Zincir işlem maliyeti (gerekiyorsa)

Kural:
- Ücretler kullanıcı onayı öncesi açık ve sayısal olarak gösterilmelidir.
- Gizli/sonradan eklenen ücret uygulanamaz.

Detaylı model: `docs/fee_model.md`.

---

## 9. Fiyatlama, kotasyon ve geçerlilik

- Kullanıcıya bir kotasyon (quote) veriliyorsa geçerlilik süresi açık yazılmalıdır.
- Kotasyon süresi dolduğunda yeni fiyat/ücret oluşabilir.
- Spread ve dönüşüm yöntemi şeffaf tanımlanmalıdır.

---

## 10. Reddetme kodları ve karar referansları

Reddetme sebebi hash referansı (`reasonHash`) ile zincire yazılır.  
Off-chain tarafta anlaşılır kod/metin tutulur (örnek kod seti):

- `KYC_MISSING_DOC`
- `SANCTIONS_HIT`
- `HIGH_RISK_SCORE`
- `JURISDICTION_BLOCKED`
- `MIN_AMOUNT_NOT_MET`
- `OPS_CAPACITY_LIMIT`
- `SUSPECTED_FRAUD`

---

## 11. Güvenlik ve suistimal önleme

- Tekrarlayan/bölerek yapılan suistimal talepleri izlenir
- Şüpheli modelde ek doğrulama istenir
- Gerekirse talep geçici olarak dondurulur ve incelemeye alınır
- Anahtar yönetimi ve onay akışları `ops/key_management.md` ile uyumlu olmalıdır

---

## 12. Rezerv muhasebesi ve PoR etkisi

Fulfilled itfa sonrası:

1. Yakılan token miktarı arzdan düşer
2. Rezerv envanterinde ilgili düşüm/ayrım kaydı yapılır
3. Periyodik PoR çıktısında bu değişim mutabakata dahil edilir

Mutabakat kuralı:
- Itfa logları ↔ token burn eventleri ↔ rezerv hareketleri düzenli olarak karşılaştırılmalıdır.

---

## 13. Kayıt saklama ve denetlenebilirlik

Aşağıdakiler saklanmalıdır:

- Talep kimliği, durum geçişleri, zaman damgaları
- Uyum karar izi (minimum gerekli veri)
- Ücret hesap çıktıları
- Fulfillment referansları
- İhtilaf/itiraz kayıtları

Saklama süresi `compliance/record_retention.md` ile uyumlu olmalıdır.

---

## 14. Şeffaflık ilkesi

Kamuya açık olarak en az şu bilgiler yayınlanmalıdır:

- İtfa minimumları
- Ücret kalemleri
- Ortalama işlem süreleri (anonim/aggrege)
- Reddedilen talepler için kategori bazlı istatistik (kimliksiz)

---

## 15. Mücbir sebep ve hizmet kesintisi

Aşağıdaki hallerde geçici hizmet kesintisi olabilir:

- Zincir altyapı kesintisi
- Saklama/lojistik erişim sorunu
- Regülasyon kaynaklı zorunlu durdurma
- Güvenlik olayı (incident response tetiklenmesi)

Kesinti halinde:
- Durum sayfası/duyuru güncellenir
- Normalleşme planı paylaşılır
- Gerekirse yeni SLA verilir

---

## 16. Değişiklik yönetimi

Bu politika değiştirildiğinde:

- Versiyon numarası artırılır
- Değişiklik özeti yayımlanır
- Yürürlük tarihi ilan edilir
- Kullanıcıyı etkileyen maddeler için makul bildirim süresi tanınır

---

## 17. Definition of Done (v0.1)

Bu doküman “hazır” sayılması için:

- Talep akışı on-chain statülerle birebir eşleşmeli
- Min miktar, ücret, SLA net olmalı
- Reddetme gerekçeleri sınıflandırılmış olmalı
- Uyum ve kayıt saklama kuralları referanslı olmalı
- PoR/mutabakat bağlantısı açık olmalı
