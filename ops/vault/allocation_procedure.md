# Vault Allocation Procedure v0.1 (GRUSH)

Bu doküman “allocated custody” modelinde, rezerv bar’ların GRUSH arzıyla nasıl ilişkilendirildiğini ve PoR’a nasıl bağlandığını tanımlar.

Normatif anahtar kelimeler: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.

İlgili:
- `docs/core-spec_v0.1.md`
- `docs/por_standard.md`
- `docs/redemption_policy.md`
- `ops/key_management.md`
- `por/schemas/bar_list.schema.json`
- `por/schemas/attestation.schema.json`
- `por/merkle/leaf_format.md`

---

## 1) Amaç ve kırmızı çizgiler

Amaç: Mint edilen GRUSH arzının, **allocated** ve **bar bazında** tanımlı rezervle bire bir eşleştiğini operasyonel olarak garanti etmek.

Kırmızı çizgiler (MUST NOT):
- Unallocated / pooled custody ile mint yapılmaz.
- Rehypothecation / lending / teminat gösterme yapılmaz.
- Aynı bar seri numarası iki farklı snapshot’ta çakışacak şekilde “çift sayım” yapılmaz.

---

## 2) Roller ve sorumluluklar (özet)

- Custodian/Vault Ops: fiziksel bar kabulü, saklama, internal kayıt
- Auditor/Assurer: snapshot doğrulama, attestation sürecinin kontrolü
- Issuance Ops (MINTER_ROLE): mint kararı ve uygulaması
- Security Ops (PAUSER_ROLE): incident durumunda pause
- PoR Publisher (PUBLISHER_ROLE): attestation’ı zincire basma

---

## 3) Allocation yaşam döngüsü

### 3.1 Bar kabul (intake)
MUST:
- Bar kimliği: `serial_no`, `refiner`, `fineness`, `fine_weight_g`, `vault_id`
- Evrak/sertifika ve teslim kayıtları saklanır (off-chain)

Output:
- Bar “available for allocation” olur.

### 3.2 Allocation (snapshot freeze)
Allocation bir “snapshot” üretir:
- `as_of_timestamp` (unix seconds)
- `report_id` (string)

MUST:
- Snapshot bar seti **sabitlenir** (freeze).
- Snapshot değişirse yeni `report_id` üretilir (MUST).

### 3.3 Bar list üretimi
MUST:
- Bar list `por/schemas/bar_list.schema.json` ile uyumlu olmalı.
- `totals.fine_gold_grams = sum(bars[].fine_weight_g)` olmalı.

Output:
- `bar_list.json`
- `bar_list_hash = keccak256(fileBytes)`

### 3.4 Merkle root üretimi
MUST:
- Leaf format `por/merkle/leaf_format.md` ile bire bir uyumlu olmalı.

Output:
- `merkle_root`

### 3.5 Attestation üretimi ve imza
Attestation payload:
- `reportId` (bytes32)
- `asOfTimestamp` (uint64)
- `attestedFineGoldGrams` (uint256)
- `merkleRoot` (bytes32)
- `barListHash` (bytes32)

MUST:
- EIP-712 ile imzalanır.
- `por/schemas/attestation.schema.json` ile uyumlu tutulur.

### 3.6 On-chain publish
MUST:
- Publisher `ReserveRegistry.publishAttestation(...)` çağırır.

---

## 4) Mint kontrolü (supply <= reserves)

MUST:
- Toplam arz, son attested gramı aşmamalı.

---

## 5) Arşiv

MUST:
- `bar_list.json`, `bar_list_hash`, `merkle_root`, attestation JSON, imza, tx hash saklanır.
