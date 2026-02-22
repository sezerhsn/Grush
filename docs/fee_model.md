# GRUSH Fee Model v0.1

Bu doküman GRUSH ekosistemindeki ücret kalemlerini, hesaplama mantığını ve kullanıcıya nasıl yansıtılacağını tanımlar.

Normatif anahtar kelimeler: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.

İlgili dokümanlar:
- `docs/redemption_policy.md`
- `docs/core-spec_v0.1.md`
- `docs/por_standard.md`
- Kontratlar: `contracts/src/GRUSHToken.sol`, `contracts/src/RedemptionGateway.sol`, `contracts/src/ReserveRegistry.sol`

---

## 1) İlke: 1 GRUSH = 1 gram (fine gold) ve ücretlerin bunu bozmaması

- GRUSH token tasarımı “1 GRUSH = 1 gram fine gold” anlatımı üzerine kurulur.
- v0.1’de **on-chain kontratlar ücret hesaplamaz / kesmez** (şu anki kodda fee mekanizması yok).
- Bu nedenle ücretler v0.1’de **off-chain** olarak tahakkuk ettirilir ve tahsil edilir.

**Kural (MUST):**
- Ücret tahsilatı, kullanıcıya teslim edilen gram karşılığını “sinsi” biçimde düşürerek yapılmamalıdır.
- Ücretler, mümkünse **fiat/stable** ile ya da kullanıcıya açıkça gösterilen ayrı kalemlerle tahsil edilmelidir.

---

## 2) Ücret kalemleri (v0.1)

### 2.1 Issuance (Mint) ücretleri
Mint işlemi, fiziksel rezervin ayrıştırılması/allocate edilmesi ve operasyonel doğrulamalar sonrası yapılır.

Olası kalemler:
- **Onboarding/KYC/KYB** (tek seferlik)
- **Issuance processing** (işlem başına sabit ücret)
- **Vault allocation** (rezerv ayrıştırma/etiketleme)
- **Audit/assurance** (periyodik, kullanıcıya paylaştırılabilir)

Tahsil şekli (v0.1 öneri):
- Off-chain faturalama (fiat/stable).
- Mint edilen GRUSH miktarı, ayrılan gram ile **bire bir** eşleşir.

### 2.2 Redemption ücretleri
Redemption akışı: kullanıcı token’ı escrow eder, iptal/redd/fulfill ile süreç tamamlanır.

Olası kalemler:
- **Redemption processing fee** (işlem başına)
- **Shipping/insurance** (fiziki teslimat varsa)
- **Customs/taxes** (bölgeye göre)
- **Bank/rail fees** (nakit itfa varsa)

Tahsil şekli (v0.1 öneri):
- Off-chain ödeme.
- On-chain taraf sadece audit log ve escrow/burn yapar.

### 2.3 Custody / storage ücreti (opsiyonel)
- Eğer “saklama ücreti” uygulanacaksa:
  - Ücret periyodu net olmalı (aylık/yıllık)
  - Hesaplama bazının ne olduğu açık olmalı (ortalama gram, gün sayısı vb.)
  - Tahsil yöntemi açıklanmalı

v0.1’de bu ücret **varsayılan olarak kapalı** kabul edilir (MAY).

---

## 3) Ücret hesaplama şablonları

Bu bölüm “şablon”dur; değerler ürün kararına göre belirlenir.

### 3.1 Sabit + değişken model
Bir işlem ücreti şu şekilde tanımlanabilir:

- `fee_total = fee_flat + fee_pct * amount`

Burada:
- `fee_flat`: sabit ücret (ör: 5 USD)
- `fee_pct`: yüzdelik ücret (ör: 0.30%)
- `amount`: işlem büyüklüğü (fiat ya da GRUSH cinsinden)

**Kural (MUST):**
- Yüzdelik ücret kullanılıyorsa hangi bazdan alındığı açık yazılmalı:
  - GRUSH miktarı mı?
  - Altın spot değeri mi?
  - Sevkiyat sigorta bedeli mi?

### 3.2 Lojistik maliyeti pass-through
Shipping/insurance kalemi “maliyet + marj” olarak yansıtılacaksa:

- `shipping_fee = carrier_quote + insurance + handling + margin`

**Kural (MUST):**
- Kullanıcıya quote geçerlilik süresi verilmelidir (ör: 15 dk / 1 saat / 24 saat).

---

## 4) Quote, geçerlilik süresi, iade ve iptal

### 4.1 Quote
- Kullanıcı bir redemption başlatmadan önce, toplam ücret kalemleri gösterilmelidir (MUST).
- Quote’ın geçerlilik süresi açık yazılmalıdır (MUST).

### 4.2 İptal
- `RedemptionGateway.cancelRedemption()` ile on-chain iptal mümkündür.
- Off-chain ödenmiş ücretler için iade politikası açık olmalıdır (MUST):
  - “işlem ücreti iade edilmez”
  - “lojistik iade koşula bağlı”
  - “vergi/harç iade edilmez” vb.

---

## 5) Şeffaflık ve değişiklik yönetimi

- Ücret değişiklikleri önceden duyurulmalıdır (SHOULD).
- Yeni ücretler, yürürlük tarihi ile birlikte yayınlanmalıdır (MUST).
- Eski quote verilmiş işlemlerde, quote süresi dolmadan ücret değiştirilemez (MUST).

---

## 6) Muhasebe / PoR etkisi

**v0.1 gerçeği:** ücretler on-chain kesilmediği için PoR üzerinde doğrudan bir “fee accounting” kontrat izi yoktur.

Kural (MUST):
- Mint edilen toplam GRUSH arzı, ayrılmış rezerv gramları ile uyumlu olmalıdır.
- Ücret tahsilatı “rezervden gram eksilterek” yapılıyorsa bu PoR’da açıkça raporlanmalıdır.

Öneri:
- Ücretleri mümkün olduğunca fiat/stable tahsil etmek, PoR tutarlılığını basitleştirir.

---

## 7) v0.2 yol haritası (gelecek uyumluluk)

İleride fee enforcement on-chain istenirse:
- FeeRegistry (parametre kontratı)
- Quote / signature based fee
- RedemptionGateway içine “fee escrow” veya “amount+fee” modeli

Bu değişiklikler gerçekleşmeden önce:
- `contracts/docs/contract-spec.md` güncellenmeli
- Testler ve security review zorunlu olmalı
