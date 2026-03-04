# Attestations (PoR imzalı beyanları)

Bu klasör, GRUSH PoR zincirlemesini yapan **imzalı attestation JSON** dosyalarını ve (varsa) **on-chain publish kanıtlarını** arşivlemek içindir.

Attestation = “belirli bir `as_of_timestamp` anında, `report_id` ile tanımlanan bar list snapshot’ının toplam fine gold gramı (`attested_fine_gold_grams`) ve ona karşılık gelen `merkle_root` / `bar_list_hash` değerleri, yetkili signer tarafından EIP-712 ile imzalandı” demektir.

Normatif anahtar kelimeler: MUST / MUST NOT / SHOULD / MAY.

---

## 1) Bu klasörde neler tutulur?

MUST:
- Attestation JSON (schema: `por/schemas/attestation.schema.json`)
- On-chain publish yapıldıysa: tx hash + block no + registry adresi (receipt/log)

SHOULD:
- “publish receipt” JSON (publish script stdout’unu dosyaya kaydet)
- Aynı `report_id` için “bar list manifest”e referans (bkz: `transparency/barlists/`)

MUST NOT:
- Signer private key / publisher private key / seed / mnemonic vb. sırlar.

---

## 2) Üretim pipeline (kısa)

Kaynak dokümanlar:
- `docs/por_standard.md`
- `por/merkle/leaf_format.md`

Adımlar:
1) Bar list snapshot üret (bkz. `transparency/barlists/`)
2) `por/merkle/build_merkle_root.ts` ile `bar_list_hash` + `merkle_root` üret
3) `por/attestation/sign_attestation.ts` ile attestation imzala (schema uyumlu çıktı üretir)
4) `por/attestation/verify_signature.ts` ile imzayı doğrula
5) `por/attestation/publish_onchain.ts` ile ReserveRegistry’ye publish et
6) Attestation dosyasını ve publish kanıtını bu klasöre koy

---

## 3) Dosya isimlendirme ve dizin düzeni

Amaç: değiştirilemez arşiv. Eski dosyalar asla “edit” edilmez; hata varsa yeni `report_id` ile yeni dosya üretilir.

### M1 (repo’daki demo düzeni) — MUST
- `transparency/attestations/<report_id>/attestation.json`
- (publish olduysa) `transparency/attestations/<report_id>/publish_receipt.json`

### İleri düzen (ağ/yıl ayrımı) — MAY
- `transparency/attestations/<network>/<YYYY>/<report_id>.attestation.json`
- `transparency/attestations/<network>/<YYYY>/<report_id>.publish_receipt.json`

`<network>` örnekleri: `sepolia`, `mainnet`.

Not:
- `report_id` string’i dosya adına giriyorsa güvenli karakter setinde tut (örn: `demo-2026-02-18-IST-003`).

---

## 4) Doğrulama (3. tarafın yapabilmesi gerekenler)

MUST:
- EIP-712 imzası geçerli mi?
- Domain doğru mu? (`chain_id` ve `reserve_registry_address` ile bire bir)
- On-chain publish edilmiş mi? (publish yapıldıysa)

Komut örnekleri (Windows/CMD):

M1 düzeni:
```bat
npx tsx por/attestation/verify_signature.ts --in transparency/attestations/<report_id>/attestation.json

---

## Verify the full snapshot
See `transparency/README.md` or run:
```bash
npx tsx tools/verify_transparency_snapshot.ts --report_id <report_id>