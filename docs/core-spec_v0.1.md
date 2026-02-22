# GRUSH Core Spec v0.1

> Bu doküman, Goldenrush (GRUSH) projesinin “çekirdek ürün sözleşmesi”dir: tokenın neyi temsil ettiği, nasıl basıldığı/yakıldığı, rezervin nasıl kanıtlandığı, itfanın nasıl çalıştığı ve sistemin güvenlik sınırları burada tanımlanır.  
> Bu bir teknik spesifikasyondur; hukuk/uyum dokümanlarıyla birlikte okunmalıdır.

## 0. Kapsam ve hedef

**Hedef:** Ethereum mainnet üzerinde çalışan, **fiziksel olarak allocated saklanan 999.9 Au** rezervine dayalı, **1 GRUSH = 1 gram fine gold** paritesini koruyan ve bunu **denetim + PoR** ile doğrulanabilir hale getiren sistem.

**Kapsam içi:**
- ERC-20 GRUSH tokenı (mint/burn kontrollü)
- ReserveRegistry (attestation + Merkle root + imzalı rezerv beyanı)
- Redemption (itfa) akışının on-chain olay kaydı (gateway) + off-chain fulfillment prosedürleri
- Rol/anahtar yönetimi, timelock ve acil durum kontrolleri
- PoR standardı ve rezerv kanıtının yayınlanma modeli

**Kapsam dışı (v0.1):**
- “Permissionless KYC-free redemption” (itfa KYC/AML gerektirebilir)
- Rehypothecation / lending / teminat gösterme (yasak)
- Unallocated/havuz saklama modeli (yasak)
- Tam Ethereum mainnet genel explorer (grushscan MVP odaklı)
- Zincirler arası köprüler (bridge) ve L2’ler (v0.2+)
- On-chain altın fiyat oracle’ı ve fiyat bazlı “peg enforcement” mekanizmaları (rebasing/algorithmic peg vb.)
- Token transferlerinde permissioned/sanctions enforce (blacklist/whitelist) stratejisi (ayrı karar dokümanı gerektirir)
- Fiat on/off-ramp (banka entegrasyonları, ödeme altyapıları) ve ödeme ürünleri
- Tam bar list’in herkese açık yayınlanması (v0.1 minimum: snapshot hash + denetçi doğrulaması)
- DAO/oylama tabanlı yönetişim (tokenholder governance) ve komple yönetişim framework’ü

---

## 1. Tanımlar

- **Fine Gold (999.9 Au):** 0.9999 saflıkta altın.
- **Peg / Parite:** 1 GRUSH tokenın nominal olarak 1 gram fine gold’a denk gelmesi.
- **Allocated custody:** Rezerv altınların bar/ingot bazında ayrılmış ve kayıt altına alınmış (seri no/rafineri/ağırlık/ayar) şekilde saklanması.
- **Bar list:** Rezervde bulunan her bir bar/ingot için kimlik ve fine-weight bilgisini içeren liste.
- **Attestation:** Bağımsız denetçi/saklayıcı tarafından belirli bir “as-of timestamp” için imzalanmış rezerv beyanı.
- **PoR (Proof of Reserves):** Bar list verisinin kriptografik özeti (Merkle root) ve bu özete referans veren imzalı attestation ile doğrulanabilir rezerv kanıtı.
- **Issuer:** Token basma/yakma yetkisini yöneten operasyonel yapı (multisig).
- **SPV/Trust:** Rezerv altının operasyon şirketinden ayrıştırıldığı (bankruptcy-remote) yapı.
- **Redemption (İtfa):** Tokenın yakılarak fiziksel altın (veya koşullara göre nakit) karşılığına dönüştürülmesi.

---

## 2. Sistem mimarisi (yüksek seviye)

### 2.1 On-chain bileşenler
- **GRUSHToken (ERC-20):**
  - Mint/Burn kontrollü
  - Pause (acil durum)
  - Role-based access control
- **ReserveRegistry:**
  - Attestation kayıtları (asOfTimestamp, attestedFineGoldGrams)
  - Merkle root yayınlama
  - EIP-712 imza doğrulama (auditor/custodian signer)
- **RedemptionGateway (opsiyonel ama önerilir v0.1):**
  - Redemption request event log’u (requestId, user, amount, destination, status)
  - Fulfillment off-chain gerçekleşir; gateway on-chain iz bırakır

### 2.2 Off-chain bileşenler
- **Custody:** İstanbul’da bankaların kasalarında allocated saklama
- **Audit/Attestation:** Bar list doğrulama + periyodik rapor
- **PoR pipeline:** Bar list -> schema validation -> leaf hashing -> Merkle root -> attestation signing -> on-chain publish
- **Fulfillment:** Fiziki teslim/çekim operasyonu, KYC/AML, lojistik

---

## 3. Temel ekonomik invariants (değişmez kurallar)

### 3.1 Rezerv–arz üst sınırı
Sistem, şu “temel güven kuralı”nı hedefler:

**Invariant A (rezerv üst sınırı):**
`totalSupply(GRUSH) <= attestedFineGoldGrams`

- `totalSupply(GRUSH)` zincirde ölçülür.
- `attestedFineGoldGrams` en güncel geçerli attestation kaydından alınır.
- Bu invariant, teknik olarak tüm zamanlarda “zorla enforce” edilmese bile:
  - Mint işlemleri yalnızca rezerv girişinden sonra yapılır (operasyonel kontrol)
  - Denetim/PoR sistemi supply–rezerv farkını ifşa eder (şeffaflık kontrolü)

> v0.2+ hedefi: Mint’in, zincirdeki “minimum güncel attestation” koşuluna bağlanması veya mint-limit mekanizması.

### 3.2 Rehypothecation yasağı
Rezerv altın:
- **ödünç verilemez**
- **teminat gösterilemez**
- **başka bir borca rehin edilemez**
- **unallocated havuza karıştırılamaz**

Bu, hem sözleşmelerde (legal/) hem operasyon prosedürlerinde (ops/) zorunlu kuraldır.

---

## 4. Token spesifikasyonu (GRUSHToken)

- **Standart:** ERC-20
- **Decimals:** 18
- **Birim tanımı:** 1 GRUSH = 1 gram (fine gold, 999.9 Au)
- **Mint/Burn:** Sadece yetkili rol (multisig) ile
- **Pause:** Sadece acil durumlar (incident) için

### 4.1 Roller
Minimum rol seti:
- `DEFAULT_ADMIN_ROLE` (sadece timelock üzerinden)
- `MINTER_ROLE`
- `BURNER_ROLE`
- `PAUSER_ROLE`

**Kural:** Admin yetkileri tek bir EOAsa olmaz. Admin işlemleri **timelock** üzerinden yürütülür.

### 4.2 Upgrade yaklaşımı
v0.1 önerisi:
- Çekirdek token kontratı **non-upgradeable** (tercih edilen)
- Registry/Gateway, gerekirse upgradeable olabilir ama:
  - timelock + çoklu imza + değişiklik politikası zorunlu

> Upgradeable yaklaşım seçilirse: “2 aşamalı değişiklik” (announce -> delay -> execute) zorunludur.

---

## 5. Rezerv ve saklama (allocated) modeli

### 5.1 Rezerv standardı
- Fine gold: 999.9 Au
- Rezerv muhasebesi **fine weight (gram)** üzerinden tutulur.

### 5.2 Bar list zorunlu alanlar
Bar list satırı minimum şu alanları içermelidir:
- `bar_id` veya `serial_no` (unique)
- `refiner`
- `gross_weight_g`
- `fineness` (örn 999.9)
- `fine_weight_g`
- `vault_id` / `location_code`
- `allocation_status` = `"allocated"`
- `as_of_timestamp`

Bu şema `por/schemas/bar_list.schema.json` ile kilitlenir.

---

## 6. PoR (Proof of Reserves) standardı

### 6.1 Leaf hashing (Merkle)
Her bar list satırı deterministik olarak leaf’e dönüştürülür.
- Canonical JSON / alan sırası / numeric encoding **sabit** olmalıdır.
- Hash fonksiyonu: **keccak256** (Ethereum uyumlu)

Leaf format detayı `por/merkle/leaf_format.md` dosyasında normatif olarak tanımlanır.

### 6.2 Attestation (imza)
Attestation JSON minimum alanlar:
- `report_id`
- `as_of_timestamp`
- `attested_fine_gold_grams`
- `merkle_root`
- `bar_list_hash` (opsiyonel ama önerilir: dosya hash’i)
- `signer` (auditor/custodian)
- `signature` (EIP-712)

Şema `por/schemas/attestation.schema.json` ile kilitlenir.

---

## 7. ReserveRegistry spesifikasyonu

ReserveRegistry’nin amacı:
- En güncel rezerv beyanını zincire “çapa”lamak
- İmzayı doğrulamak
- Zaman serisi halinde attestation geçmişi tutmak (event log + storage)

### 7.1 Fonksiyonel beklentiler
- `publishAttestation(...)`:
  - EIP-712 signature doğrular
  - `reportId` benzersizliğini enforce eder
  - `asOfTimestamp` geriye dönük olsa bile kayıt altına alabilir (ama UI “latest” seçer)
- `getLatestAttestation()`:
  - latest kriteri: `asOfTimestamp` en yüksek (veya policy ile “finalized”)

### 7.2 Zincir üstü doğrulama hedefi
- Kullanıcılar:
  - `totalSupply(GRUSH)`
  - `latest attestedFineGoldGrams`
  - `merkleRoot`
  değerlerini grushscan üzerinde tek ekranda görür.

---

## 8. Mint/Burn operasyon modeli (normatif)

### 8.1 Mint ön koşulları (MUST)
Mint işlemi yapılmadan önce:
1) Fiziki altın kasaya girmiş olmalı (intake)
2) Allocated olarak tahsis edilip bar list’e eklenmiş olmalı
3) Bar list schema validation geçmiş olmalı
4) Merkle root üretilmiş ve imzalı attestation hazırlanmış olmalı
5) Attestation zincire publish edilmiş olmalı (tercih edilen) veya aynı gün publish edilecek şekilde operasyonel taahhüt olmalı

### 8.2 Burn/Redemption ön koşulları (MUST)
Redemption/burn sürecinde:
- Kullanıcıdan KYC/AML gerekebilir (compliance politikalarına göre)
- Burn gerçekleştiğinde karşılık rezervden düşülür ve bar list güncellenir
- Fulfillment (fiziki teslim) off-chain gerçekleşir; gateway on-chain event üretir

---

## 9. Redemption (itfa) modeli

v0.1’de iki itfa türü tanımlanır:
- **Fiziki itfa:** gram bazlı teslim (1g/5g/10g/100g/1kg ürünleri operasyonel olarak belirlenir)
- **Nakit itfa (opsiyonel):** yerel mevzuat/uyuma bağlı

Normlar `docs/redemption_policy.md` ve `legal/spv-trust/redemption_policy_terms.md` içinde detaylandırılır.

---

## 10. Ücretler (fee model) – şeffaflık kuralı

“Depolama ücreti yok” iddiası kullanılacaksa:
- Maliyetlerin nereden çıktığı açıkça yazılmalıdır:
  - spread / mint fee / redemption fee / kurumsal gelir
- Ücret politikası `docs/fee_model.md` ile normatif hale getirilir.
- UI’da ve grush.org’da görünür olmalıdır.

---

## 11. Güvenlik ve anahtar yönetimi (v0.1 minimum)

### 11.1 Multisig
- Mint/Burn/Pauser rollerinin sahibi **multisig** olmalıdır.
- Önerilen eşik: 3/5 veya 4/7 (operasyon ölçeğine göre).

### 11.2 Timelock
- Admin değişiklikleri timelock üzerinden yapılır:
  - role grant/revoke
  - pause/unpause policy değişiklikleri (mümkünse)
  - upgrade (varsa)

### 11.3 Incident (acil durum) politikası
- Pause şartları ve geri dönüş prosedürü `ops/incident_response.md` içinde yazılı olmalıdır.
- “Kim, hangi koşulda, hangi kanıtla pause eder?” net olmalıdır.

---

## 12. Uyum (compliance) – ürün gerçeği

GRUSH, itfa ve müşteri kabulü nedeniyle AML/KYC yükümlülükleri doğurabilir.
Bu kapsam:
- `compliance/aml_policy.md`
- `compliance/kyc_kyb_flow.md`
- `compliance/sanctions_screening.md`
- `compliance/record_retention.md`
dokümanları ile ürünün operasyon gerçeğine bağlanır.

> v0.1 hedefi: “itfa kapısı” kesinlikle uyumlu tasarlanır. Transfer tarafı stratejik karardır (permissioned/permissionless), ayrı karar dokümanı gerekir.

---

## 13. Şeffaflık deliverable’ları (minimum set)

v0.1’de halka açık olarak sunulması beklenenler:
- En güncel attestation (on-chain + JSON)
- Attestation geçmişi (timeline)
- Bar list snapshot hash’leri (bar list’in tamamı yayınlanmasa bile en az hash + denetçi doğrulaması)
- Mint/Burn event’leri
- Ücretler ve itfa koşulları

Bunlar `transparency/` klasörü altında arşivlenir.

---

## 14. Versiyonlama ve değişiklik yönetimi

- Bu doküman `v0.1`’dir.
- Değişiklikler:
  - `CHANGELOG.md`’e girer
  - grush.org “changelog/launch notes” sayfasında duyurulur
  - Timelock gerektiren on-chain değişiklikler için “announce -> delay -> execute” uygulanır.

---

## 15. Parametreler (placeholder)

Aşağıdaki parametreler deploy öncesi netleştirilecektir:
- `TOKEN_NAME` = "Goldenrush"
- `TOKEN_SYMBOL` = "GRUSH"
- `DECIMALS` = 18
- `MULTISIG_ADDRESS` = TBD
- `TIMELOCK_ADDRESS` = TBD
- `AUDITOR_SIGNER_ADDRESS` = TBD
- `CUSTODIAN_SIGNER_ADDRESS` = TBD
- `PAUSE_POLICY` = ops/incident_response.md’e bağlı

---

## 16. Ek: Kabul kriterleri (Definition of Done) – Core Spec

Core Spec v0.1 “hazır” sayılması için:
- Peg tanımı ve invariantlar yazılı
- Allocated saklama ve bar list alanları yazılı
- PoR standardı (Merkle + EIP-712 imza) tanımlı
- Mint/Burn süreç ön koşulları net
- Multisig + timelock minimum güvenlik politikası var
- Ücret ve itfa dokümanlarına referanslar ve sınırlar tanımlı

---
