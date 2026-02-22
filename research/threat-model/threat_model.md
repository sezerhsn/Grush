# GRUSH Threat Model v0.1

Bu doküman GRUSH v0.1 sisteminin tehdit modelidir: varlıklar, aktörler, güven sınırları, saldırı yüzeyleri ve “en büyük 15 risk + mitigasyon” burada kilitlenir.

Referans dokümanlar:
- docs/core-spec_v0.1.md
- docs/por_standard.md
- por/merkle/leaf_format.md
- contracts/docs/contract-spec.md
- ops/key_management.md
- ops/vault/allocation_procedure.md
- docs/redemption_policy.md

---

## 1) Kapsam

### 1.1 Kapsam içi (v0.1)
- On-chain:
  - GRUSHToken (mint/burn/pause/roles)
  - ReserveRegistry (attestation + Merkle root + EIP-712 signature verify)
  - RedemptionGateway (request log + escrow + burn / fulfill)
- Off-chain:
  - Custody (allocated vault/banka kasası)
  - Bar list üretimi, schema validation, leaf hashing, Merkle root üretimi
  - Attestation imzalama ve yayınlama
  - Redemption operasyonu (KYC/AML, fulfillment, lojistik)

### 1.2 Kapsam dışı (tehdit modelinin de kapsam dışı)
- Zincirler arası köprüler (bridge) / L2 operasyonu
- Permissionless KYC-free redemption
- Rehypothecation / lending / teminat gösterme (zaten yasak; “nasıl yapılır” ele alınmaz)
- “Altın fiyatı oracle” veya on-chain fiyat feed’i ile peg enforcement

---

## 2) Güven varsayımları

- Ethereum L1 güvenliği ve finality varsayılır (reorg riskine karşı UI/indexer önlemleri gerekir).
- OpenZeppelin v5 ve Solidity ^0.8.24 kullanımıyla temel güvenlik sınıfı sağlanır; yine de audit şarttır.
- Custodian/auditor imza anahtarları güvenli saklanır varsayımı **yoktur**: kompromize senaryosu modelin içindedir.
- “1 GRUSH = 1g fine gold” peg’i v0.1’de **operasyon + denetim** ile korunur; on-chain zorla enforce edilmez (bu bir risk kalemi).

---

## 3) Korunan varlıklar (Assets)

A1. Fiziki rezerv (allocated 999.9 Au bar/ingot)  
A2. Bar list verisi (ham veri + snapshot)  
A3. Merkle root ve leaf format standardı (deterministik doğrulama)  
A4. Attestation imzası (EIP-712) ve signer private key’leri  
A5. Multisig private key’leri (mint/burn/pause ve admin işlemleri)  
A6. Timelock yetkileri ve yönetim akışı  
A7. Redemption operasyon kayıtları (request, status, fulfillment ref)  
A8. Kullanıcı PII (KYC/AML verisi) — zincir dışı  
A9. Şeffaflık arşivi (transparency snapshots + hash/tx bağları)  
A10. İtibar ve hukuki dayanıklılık (SPV/Trust yapı bütünlüğü)

---

## 4) Aktörler ve tehdit kaynakları

T1. Dış saldırgan (on-chain exploit / off-chain intrusion)  
T2. Kötü niyetli veya kompromize insider (ops, dev, custodian)  
T3. Kompromize auditor/custodian signer  
T4. Regülatif/kurumsal risk (hesap dondurma, el koyma, yargı kararları)  
T5. Ağ/ekosistem riski (reorg, MEV, RPC/Indexer manipulasyonu)  
T6. Kullanıcı hatası / sosyal mühendislik

---

## 5) Güven sınırları (Trust boundaries)

B1. Ethereum zinciri ↔ off-chain sistemler (por pipeline, ops, KYC)  
B2. Custody kuruluşu ↔ issuer ops  
B3. Auditor ↔ issuer (attestation otoritesi)  
B4. Multisig signers ↔ timelock admin mekanizması  
B5. Public transparency ↔ gizli/PİI verisi

---

## 6) Saldırı yüzeyi (Attack surface)

S1. Kontrat fonksiyonları (mint/burn/pause/role yönetimi/attestation publish/redemption)  
S2. EIP-712 domain/type ayrıntıları (imza doğrulama hataları)  
S3. Leaf encoding / canonicalization (hash uyuşmazlığı)  
S4. Bar list snapshot dosyaları (tamper / leak)  
S5. Operational key management (MPC/HSM yoksa yüksek risk)  
S6. Indexer/UI “latest attestation” seçimi ve reorg dayanıklılığı  
S7. Redemption operasyonu (SLA, reject/fulfill suistimali, iç dolandırıcılık)

---

## 7) En büyük 15 risk + mitigasyon (normatif liste)

Aşağıdaki riskler “v0.1’de en kritik” olarak kilitlenmiştir.
Her risk için: Önleme (Prevent), Tespit (Detect), Müdahale (Respond) ve Kanıt (Evidence) alanları tanımlanır.

### TM-01 — Rezerv açığı / sahte rezerv beyanı (custody fraud)
- Senaryo: Fiziki altın eksik; bar list/attestation gerçeği yansıtmıyor.
- Etki: Peg çöküşü + hukuki/itibar ölümü.
- Mitigasyon:
  - Prevent: Allocated custody + bağımsız denetim + SPV/Trust; rehypothecation kesin yasak.
  - Detect: Attestation timeline + supply vs attested grams fark alarmı; periyodik reconciliation.
  - Respond: Pause + redemption stop + kamuya incident bildirimi + yeni denetim.
  - Evidence: Audit raporu, custody receipt, bar list hash + Merkle root + on-chain tx.

### TM-02 — Attestation signer private key kompromizi
- Senaryo: Saldırgan geçerli imza üretip sahte attestation publish eder.
- Mitigasyon:
  - Prevent: HSM/MPC/threshold signing; allowlist signer; key rotation prosedürü.
  - Detect: Çoklu signer yaklaşımı (en az 2 bağımsız imza opsiyonu); anomalik rapor denetimi.
  - Respond: Signer revoke (on-chain), yeni signer seti, incident runbook.
  - Evidence: setAllowedSigner events + yeni attestation.

### TM-03 — Multisig kompromizi / signer collusion (yetkisiz mint)
- Senaryo: Multisig ele geçirilir veya içerde anlaşmalı mint yapılır.
- Mitigasyon:
  - Prevent: Yüksek eşik (3/5, 4/7), ayrı kurum/kişi dağılımı, donanım cüzdan, policy.
  - Detect: Mint event monitoring + supply/attestation fark alarmı.
  - Respond: Pause + role revoke + yeni multisig geçişi (timelock kontrollü).
  - Evidence: Minted/Transfer eventleri + multisig tx kayıtları.

### TM-04 — Timelock/admin capture (yönetim ele geçirilmesi)
- Senaryo: Admin rolleri ele geçirilir; signer allowlist değiştirilir; roller dağıtılır.
- Mitigasyon:
  - Prevent: Admin sadece timelock üzerinden; timelock delay; “announce→delay→execute”.
  - Detect: Admin işlemlerinin izlenmesi + public changelog.
  - Respond: Emergency timelock guardian (tasarıma göre), sözleşme migrasyonu.
  - Evidence: RoleGranted/RoleRevoked + timelock queue/execute log.

### TM-05 — Smart contract bug (access control bypass / pause bypass / burn accounting)
- Senaryo: Yetkisiz mint/burn veya pause bypass; redemption escrow muhasebe hatası.
- Mitigasyon:
  - Prevent: Invariant-first test, fuzzing, static analysis (Slither), OZ v5.
  - Detect: On-chain invariants + monitoring.
  - Respond: Pause + patch (yeni deploy) + rol geçiş planı.
  - Evidence: Test suite + audit raporu + diff.

### TM-06 — EIP-712 domain/type mismatch (imza doğrulama açığı)
- Senaryo: ChainId/verifyingContract veya typed data alanları yanlış; replay veya yanlış recover.
- Mitigasyon:
  - Prevent: Domain ve type’ların spec ile birebir kilitlenmesi; test vector seti.
  - Detect: publishAttestation’da recoveredSigner doğrulaması + allowlist.
  - Respond: Registry upgrade/migration (gerekirse) + signer rotation.
  - Evidence: Test vectors + on-chain recoveredSigner çıktıları.

### TM-07 — Leaf canonicalization hatası (Merkle root uyuşmazlığı / yanlış doğrulama)
- Senaryo: JSON sırası/numeric encoding farklı; aynı bar list farklı root üretir.
- Mitigasyon:
  - Prevent: Tek referans implementasyon + leaf_format.md “normatif”; golden test vectors.
  - Detect: Pipeline cross-implementation check (2 bağımsız implementasyon).
  - Respond: Standard version bump + yeni root/attestation; eski snapshot arşivi.
  - Evidence: Test vectors + snapshot hash.

### TM-08 — Bar list tamper (snapshot değiştirme) / arşiv bütünlüğü
- Senaryo: Yayınlanan bar list snapshot sonradan değiştirilir, hash/tx bağı kopar.
- Mitigasyon:
  - Prevent: Snapshot hash’lerini on-chain veya immutable storage’a bağlama; WORM arşiv.
  - Detect: Hash doğrulama aracı + düzenli denetim.
  - Respond: Incident bildirimi + yeniden yayın + kök neden analizi.
  - Evidence: Snapshot file hash + attestation barListHash + tx.

### TM-09 — PII sızıntısı (KYC/AML verisi)
- Senaryo: Redemption/KYC sistemi sızar; kullanıcı verileri ifşa olur.
- Mitigasyon:
  - Prevent: PII’yi zincire yazmama; şifreleme; erişim kontrolü; veri minimizasyonu.
  - Detect: SIEM/alerting; erişim logları.
  - Respond: Regülasyon bildirimleri + kullanıcı bilgilendirme + sistem izolasyonu.
  - Evidence: Access logs + incident raporu.

### TM-10 — Redemption operasyon suistimali (operator kötüye kullanım)
- Senaryo: Operator haksız reject/fulfill; SLA ihlali; “iade etmem” gibi suistimal.
- Mitigasyon:
  - Prevent: SOP + ayrıştırılmış yetkiler + çift kontrol (4-eyes) + audit trail.
  - Detect: Gateway eventleri + off-chain case management logları.
  - Respond: Dispute/appeal süreci; operator key rotate; incident runbook.
  - Evidence: requestId timeline + fulfillmentRef + ops kayıtları.

### TM-11 — Regülatif/kurumsal dondurma/el koyma
- Senaryo: Banka kasasına erişim kısıtlanır; redemption durur.
- Mitigasyon:
  - Prevent: Çoklu custody, hukuki yapı (SPV/Trust), sigorta ve contingency.
  - Detect: Vault erişim SLA ölçümü; erken uyarı.
  - Respond: Redemption policy’de alternatifler (bekletme/nakit opsiyonu) + kamu açıklaması.
  - Evidence: Hukuki bildirimler + custody sözleşmeleri.

### TM-12 — Zincir reorg / indexer hatası (yanlış “latest” gösterimi)
- Senaryo: UI yanlış attestation’ı “latest” sanır; kullanıcı yanlış güven sinyali alır.
- Mitigasyon:
  - Prevent: Finality window; reorg-safe indexleme; canonical chain check.
  - Detect: Indexer integrity check; node diversity.
  - Respond: UI düzeltmesi + yeniden indeks.
  - Evidence: Block hash/finality kayıtları.

### TM-13 — Attestation spam / storage bloat
- Senaryo: publish spam; gereksiz reportId birikir; indexer maliyeti artar.
- Mitigasyon:
  - Prevent: PUBLISHER_ROLE; reportId uniqueness; rate-limit ops policy.
  - Detect: Publish frekansı alarmı.
  - Respond: Publisher revoke; yeni publisher.
  - Evidence: AttestationPublished event analizi.

### TM-14 — “Peg” yanlış pazarlanması / beklenti yönetimi (hukuki risk)
- Senaryo: Kullanıcı “anında 1:1 fiyat garantisi” sanır; redemption gerçekliği farklı.
- Mitigasyon:
  - Prevent: Disclosure; fee/SLA/limitlerin netliği; reklam dilinin kontrolü.
  - Detect: Şikayet trendi + müşteri destek metrikleri.
  - Respond: Politika güncelleme + kamu duyurusu.
  - Evidence: grush.org içerik sürümleme + changelog.

### TM-15 — Upgrade/migration riskleri (yeni kontrata geçişte güven kaybı)
- Senaryo: Bug fix için yeni kontrat deploy; rol geçişi hatalı; kullanıcı fonksiyonsuz kalır.
- Mitigasyon:
  - Prevent: Non-upgradeable tercih; migration playbook; timelock ile duyuru.
  - Detect: Dry-run deploy + checklist + bağımsız göz.
  - Respond: Rollback planı + incident yönetimi.
  - Evidence: Deploy doğrulama, multisig tx, migration raporu.

---

## 8) Minimum kontrol seti (v0.1)

- Key mgmt: multisig threshold + donanım cüzdan + ayrık saklama + rotation
- Timelock: admin işlemlerinde gecikme + duyuru
- Monitoring: totalSupply vs attestedFineGoldGrams alarmı
- PoR: schema validation + canonical leaf hashing + test vectors
- Transparency: snapshot hash ↔ attestation ↔ on-chain tx bağları
- Incident: pause policy + iletişim ve recovery planı

---

## 9) Açık işler (Aşama 0 kapanışı için)
- ops/incident_response.md doldurulacak (pause kriterleri, roller, iletişim akışı)
- por/merkle/leaf_format.md normatif olarak finalize edilecek (Aşama 1 işi)

