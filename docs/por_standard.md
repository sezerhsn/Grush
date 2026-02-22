# GRUSH Proof of Reserves (PoR) Standard v0.1

Bu doküman GRUSH için “rezerv kanıtı” standardını normatif olarak tanımlar.
Amaç: Off-chain bar list (allocated fizikî altın envanteri) ile on-chain GRUSH arzını herkesin doğrulayabileceği şekilde bağlamak.

Bu standart üç parçadan oluşur:
1) **Bar List** (envanter verisi) + JSON Schema
2) **Merkle Root** (kriptografik özet) + leaf format standardı
3) **Attestation** (imzalı beyan) + on-chain publish

> Normatif anahtar kelimeler: MUST / MUST NOT / SHOULD / MAY.

---

## 1. Hedefler

PoR standardı aşağıdakileri sağlamalıdır:

- **Deterministik:** Aynı bar list girdisi -> aynı leaf -> aynı Merkle root.
- **Doğrulanabilir:** Herkes (3. taraf dahil) Merkle proof ile bar list satırının köke dahil olduğunu doğrulayabilmeli.
- **Bağlayıcı:** Attestation, belirli bir “as_of_timestamp” anında belirli bir “attested_fine_gold_grams” toplamını ve buna karşılık gelen “merkle_root”u imza ile bağlamalı.
- **On-chain çapa:** Attestation verisi ReserveRegistry kontratına publish edilerek değiştirilemez bir zaman serisi oluşturmalı.
- **Operasyonel uyumlu:** Custody + audit süreçlerine uygun veri akışıyla üretilebilmeli.

---

## 2. Artefaktlar ve dosya konumları

Bu repo içinde PoR artefaktları:

- Bar list schema:
  - `por/schemas/bar_list.schema.json`
- Attestation schema:
  - `por/schemas/attestation.schema.json`
- Leaf format standardı:
  - `por/merkle/leaf_format.md`
- Referans implementasyon (scriptler):
  - `por/merkle/build_merkle_root.ts`
  - `por/merkle/verify_proof.ts`
  - `por/attestation/sign_attestation.ts`
  - `por/attestation/verify_signature.ts`
  - `por/attestation/publish_onchain.ts`

---

## 3. Veri akışı (pipeline)

### 3.1 Bar list üretimi
1) Custody/ops, allocated rezerv envanterini çıkarır.
2) Bar list JSON, `bar_list.schema.json` ile validate edilir.
3) Bar listteki `bars[]` kaydı **deterministik sıraya** getirilir (bkz. §4.2).

### 3.2 Merkle root üretimi
1) Her bar satırı için leaf preimage hazırlanır (bkz. `por/merkle/leaf_format.md`).
2) Leaf hash’ler hesaplanır.
3) Merkle tree deterministik inşa edilir (bkz. §4.3) ve `merkle_root` üretilir.

### 3.3 Attestation oluşturma
1) `attested_fine_gold_grams` = bar listteki `fine_weight_g` toplamı.
2) Attestation JSON hazırlanır ve `attestation.schema.json` ile validate edilir.
3) Attestation, belirlenen signer tarafından **EIP-712** ile imzalanır.
4) İmza doğrulanır (ön üretim kontrolü).

### 3.4 On-chain publish
- Attestation, `ReserveRegistry` kontratına publish edilir.
- Publish işlemi event üretir ve zaman serisine eklenir.

---

## 4. Determinizm kuralları (kritik)

### 4.1 Sayısal alanlar
- `fine_weight_g` MUST bir **tam sayı** (integer) olarak tutulmalıdır.
  - “1 gram” = 1, “1kg” = 1000.
  - Ondalık gram MUST NOT kullanılmaz (gerekirse daha küçük birim tanımlanır; v0.1 kapsam dışı).

### 4.2 Bar sıralaması (canonical order)
Merkle root üretiminden önce bar listteki `bars[]` aşağıdaki anahtara göre sıralanmalıdır:

1) `serial_no` (lexicographic, ASCII)
2) eşitlikte `refiner` (lexicographic)
3) eşitlikte `vault_id` (lexicographic)

Bu sıralama MUST uygulanır. Aksi durumda farklı root’lar oluşur.

### 4.3 Merkle tree inşa kuralı
- Leaf hash’ler sıralı liste halinde `L[0..n-1]`.
- İç düğüm hash’i:
  - `Hnode = keccak256(0x01 || left || right)`
- Leaf hash’i:
  - `Hleaf = keccak256(0x00 || leaf_preimage_bytes)`
- Ağaç:
  - Çiftler sırayla birleştirilir: (0,1), (2,3), ...
  - Katmanda tek eleman kalırsa, son eleman **kendisiyle eşleştirilir** (duplicate-last).
- Pair sorting (left/right yer değiştirme) MUST NOT yapılmaz.
  - Sol/sağ konumu listedeki sıraya göre belirlenir.

---

## 5. Hash fonksiyonları ve kodlama

- Hash fonksiyonu: **keccak256** (Ethereum uyumlu).
- Leaf preimage bytes: UTF-8 encoded canonical JSON (bkz. `leaf_format.md`).

---

## 6. Attestation imza standardı (EIP-712)

Attestation imzası MUST EIP-712 ile atılır.

- Domain alanları:
  - `name`: `"GRUSH Reserve Attestation"`
  - `version`: `"1"`
  - `chainId`: (Ethereum mainnet: 1)
  - `verifyingContract`: ReserveRegistry adresi

- Typed data (v0.1):
  - `reportId` (bytes32)
  - `asOfTimestamp` (uint64)
  - `attestedFineGoldGrams` (uint256)
  - `merkleRoot` (bytes32)
  - `barListHash` (bytes32)

Bu alanlar, attestation JSON’da açıkça bulunmalıdır.

---

## 7. Doğrulama adımları (kullanıcı / üçüncü taraf)

Bir doğrulayıcı aşağıdakileri yapabilmelidir:

1) Attestation JSON schema valid mi?
2) Attestation EIP-712 imzası geçerli mi? signer doğru mu?
3) ReserveRegistry’de publish edilmiş mi? (event + storage)
4) Bar list JSON schema valid mi?
5) Bar list -> canonical sort -> leaf hashing -> merkle root hesapla -> attestation’daki root ile eşleşiyor mu?
6) İstenirse tek bar satırı için proof doğrulaması:
   - bar satırı -> leaf -> verilen proof -> root = attestation root?

---

## 8. Güvenlik notları

- Bu PoR standardı **fizikî saklama risklerini** ortadan kaldırmaz; sadece kanıtlanabilirlik ve şeffaflık sağlar.
- Signer anahtarları yüksek kritik seviyededir (ops/key_management.md).
- Bar list tam yayınlanmayabilir; en azından bar list hash ve denetçi doğrulaması public olmalıdır.
- Reorg riskleri grushscan/indexer katmanında ele alınmalıdır.

---

## 9. Versiyonlama

- `schema_version` alanları MUST bulunur.
- `v0.1` standardı değişirse:
  - `CHANGELOG.md` güncellenir
  - grush.org üzerinde duyurulur
  - eski raporlar immutable kalır

---
