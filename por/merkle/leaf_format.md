# GRUSH PoR Leaf Format v0.1 (Normatif)

Bu doküman, bar list satırlarının Merkle leaf’e ve leaf’lerin Merkle root’a nasıl dönüştürüleceğini normatif olarak tanımlar.
Amaç: Herkesin aynı bar list dosyasından aynı leaf hash ve aynı Merkle root üretmesini garanti etmek.

> v0.1 hash: keccak256  
> v0.1 domain separation: prefix byte (0x00 leaf, 0x01 node)

Normatif anahtar kelimeler: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.

Referans implementasyon:
- `por/merkle/hash_utils.ts`
- `por/merkle/build_merkle_root.ts`
- `por/merkle/verify_proof.ts`

---

## 1) LeafInput (canonical bar entry)

Her `bars[]` elemanı leaf üretimi için aşağıdaki alanlara indirgenir.
LeafInput **MUST** sadece bu alanları içermelidir:

- `serial_no` (string)
- `refiner` (string)
- `fine_weight_g` (integer)
- `fineness` (string, v0.1: "999.9")
- `vault_id` (string)
- `as_of_timestamp` (integer)  ← bar list üst seviyesinden (snapshot bağlayıcısı)

**Not (v0.1):** `gross_weight_g`, `notes` vb. alanlar leaf’e dahil edilmez.

### Tip ve değer kuralları
- `fine_weight_g` **MUST** integer (decimal yok)
- `as_of_timestamp` **MUST** integer (Unix epoch seconds)
- String alanlar case-sensitive ve “as-is” kullanılır (trim/normalize yapılmaz)

---

## 2) Canonical bar sıralaması (bars[] order)

Merkle leaf üretimine geçmeden önce `bars[]` listesi **MUST** canonical olarak sıralanır:

1) `serial_no` artan (lexicographic)
2) eşitse `refiner` artan (lexicographic)
3) eşitse `vault_id` artan (lexicographic)

Bu sıralama uygulanmadan üretilen root v0.1 standardına uymaz.

---

## 3) Canonical JSON encoding

Leaf preimage bytes **MUST**, LeafInput’in canonical JSON temsili olmalıdır:

v0.1 canonicalization:
- JSON whitespace içermez
- UTF-8 encoding
- Object key sırası **sabit** olmalıdır:
  `["as_of_timestamp","fineness","fine_weight_g","refiner","serial_no","vault_id"]`
- `fine_weight_g` ve `as_of_timestamp` JSON number (integer) olarak yazılır
- Fazladan alan **MUST NOT** eklenir

Örnek LeafInput (object):
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