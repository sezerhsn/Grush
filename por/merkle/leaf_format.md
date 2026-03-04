# GRUSH PoR Leaf Format v0.1 (Normatif)

Bu doküman, bar list satırlarının Merkle leaf’e ve leaf’lerin Merkle root’a nasıl dönüştürüleceğini **normatif** olarak tanımlar.

Amaç: Herkesin aynı bar list dosyasından aynı **leaf hash** ve aynı **Merkle root** üretmesini garanti etmek.

- v0.1 hash: `keccak256`
- v0.1 domain separation: prefix byte
  - `0x00` = leaf preimage prefix
  - `0x01` = node preimage prefix

Normatif anahtar kelimeler: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.

Referans implementasyon:
- `por/merkle/hash_utils.ts`
- `por/merkle/build_merkle_root.ts`
- `por/merkle/verify_proof.ts`
- `por/merkle/check_test_vectors.ts`

---

## 0) Tanımlar

- **bytes32 hex**: `0x` ile başlayan **64 hex** karakter (toplam 66 char).
- `keccak256(x)`: Ethereum’un standart Keccak-256 fonksiyonu.
- `||`: byte dizisi birleştirme (concatenation).
- `UTF-8(s)`: string’in UTF-8 byte karşılığı.
- `BYTES32(0x...)`: bytes32 hex’in 32 byte raw karşılığı.

Bu standardın çıktıları (leaf hash, node hash, merkle root) **MUST** bytes32 hex formatında olmalıdır.

---

## 1) LeafInput (canonical bar entry)

Her `bars[]` elemanı leaf üretimi için aşağıdaki alanlara indirgenir.
LeafInput **MUST** sadece bu alanları içermelidir:

- `serial_no` (string)
- `refiner` (string)
- `fine_weight_g` (integer)
- `fineness` (string, v0.1: `"999.9"`)
- `vault_id` (string)
- `as_of_timestamp` (integer)  ← bar list üst seviyesinden (snapshot bağlayıcısı)

**Not (v0.1):** `gross_weight_g`, `notes`, `allocation_status` vb. alanlar leaf’e dahil edilmez.

### Tip ve değer kuralları
- `fine_weight_g` **MUST** integer (decimal yok)
- `as_of_timestamp` **MUST** integer (Unix epoch seconds)
- `fineness` **MUST** tam olarak `"999.9"` (string)
- String alanlar case-sensitive ve “as-is” kullanılır:
  - trim / normalize / unicode fold **MUST NOT** yapılmaz

---

## 2) Canonical bar sıralaması (bars[] order)

Merkle leaf üretimine geçmeden önce `bars[]` listesi **MUST** canonical olarak sıralanır:

1) `serial_no` artan (lexicographic)
2) eşitse `refiner` artan (lexicographic)
3) eşitse `vault_id` artan (lexicographic)

Bu sıralama uygulanmadan üretilen root v0.1 standardına uymaz.

---

## 3) Canonical JSON encoding

Leaf preimage bytes **MUST**, LeafInput’in canonical JSON temsili olmalıdır.

v0.1 canonicalization:
- JSON whitespace içermez
- UTF-8 encoding
- Object key sırası **MUST** sabit olmalıdır:
  `["as_of_timestamp","fineness","fine_weight_g","refiner","serial_no","vault_id"]`
- `fine_weight_g` ve `as_of_timestamp` JSON number (integer) olarak yazılır
- Fazladan alan **MUST NOT** eklenir

Örnek LeafInput:
```json
{
  "as_of_timestamp": 1760000000,
  "fineness": "999.9",
  "fine_weight_g": 1000,
  "refiner": "ACME",
  "serial_no": "ABCD-1234",
  "vault_id": "IST-VAULT-01"
}
```

---

## 4) Leaf hash (v0.1)

Leaf hash **MUST** şu şekilde hesaplanır:

1) `j = CanonicalJson(LeafInput)`  (Bölüm 3)
2) `b = UTF-8(j)`
3) `leaf_hash = keccak256( 0x00 || b )`

Çıktı bytes32 hex olmalıdır.

---

## 5) Node hash (v0.1)

İki child hash’ten parent üretimi **MUST** şu şekilde yapılır:

- Girdi: `left` ve `right` **MUST** bytes32 hex olmalıdır.
- `node_hash = keccak256( 0x01 || BYTES32(left) || BYTES32(right) )`

**Önemli:**
- Pair sorting yoktur. `left/right` sırası **MUST** korunur.
- Prefix’siz kullanım (`keccak256(left||right)`) **MUST NOT** yapılır.

---

## 6) Merkle root hesaplama (v0.1)

- Leaf listesi **MUST** Bölüm 2’deki canonical bar sıralamasına göre üretilmelidir.
- Leaf sayısı `N` için:
  - `N >= 1` **MUST** (boş bar list root üretmez; hata sayılır)
  - `N == 1` ise `merkle_root = leaf_hashes[0]`

Aksi halde iteratif seviye üretimi:

1) `level = leaf_hashes` (bytes32 hex list)
2) `level.length > 1` oldukça:
   - Eğer `level.length` tek ise: **duplicate-last** uygulanır:
     - `level.push(level[level.length - 1])`
   - Sonra ikili hash’leme:
     - `next[i] = NodeHash(level[2i], level[2i+1])`
   - `level = next`
3) `merkle_root = level[0]`

---

## 7) Inclusion proof formatı ve doğrulama

Bu repo’nun doğrulama aracı (`por/merkle/verify_proof.ts`) ile uyumlu proof formatı:

`proof.json`:
```json
{
  "siblings": ["0x...bytes32", "0x...bytes32"],
  "positions": ["left", "right"]
}
```

Kurallar:
- `siblings[]` **MUST** bytes32 hex olmalıdır.
- `positions[]` uzunluğu **MUST** `siblings.length` ile aynı olmalıdır.
- `positions[i]` anlamı:
  - `"left"`: parent = NodeHash(sibling, hash)
  - `"right"`: parent = NodeHash(hash, sibling)

Doğrulama algoritması:

1) `h = LeafHash(LeafInput)`
2) Her adım için:
   - `h = (pos=="left") ? NodeHash(sibling, h) : NodeHash(h, sibling)`
3) Proof geçerli iff `h == merkle_root`