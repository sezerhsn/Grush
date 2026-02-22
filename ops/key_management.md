# Key Management & Operational Security v0.1 (GRUSH)

Bu doküman production anahtar yönetimi, rol atamaları ve incident response prosedürünü tanımlar.

Normatif anahtar kelimeler: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.

---

## 1) Anahtar sınıfları

### 1.1 Governance keys (yüksek yetki)
Kapsam:
- Kontratların `DEFAULT_ADMIN_ROLE` sahibi
- Rol grant/revoke, kritik parametre değişiklikleri

Öneri:
- **Timelock + multisig** (MUST)
- Threshold: en az 2/3 veya 3/5 (SHOULD)

### 1.2 Ops keys (orta yetki)
Kapsam:
- Issuance (MINTER_ROLE)
- Redemption operator (OPERATOR_ROLE)
- Publisher (PUBLISHER_ROLE)

Öneri:
- Multisig (MUST)
- Günlük operasyon için ayrı multisig’ler (SHOULD)

### 1.3 Security keys (acil durum)
Kapsam:
- Pauser roller: `PAUSER_ROLE` (token, registry, gateway)

Öneri:
- Ayrı security multisig (MUST)
- 24/7 erişim + runbook + alarm mekanizması (MUST)

### 1.4 Attestation signing keys (kritik)
Kapsam:
- ReserveRegistry EIP-712 attestation imzasını atan anahtar(lar)

Öneri:
- HSM veya MPC (MUST)
- Online hot key yerine kontrollü signing service (SHOULD)
- Signer allowlist ReserveRegistry’de tutulur; signer rotation buradan yönetilir.

---

## 2) Anahtar üretimi (key ceremony)

### 2.1 Üretim
- Governance / ops multisig’ler bir “key ceremony” ile üretilmelidir (MUST).
- Seed phrase tek kişinin elinde kalmamalı (MUST NOT).

### 2.2 Yedekleme
- Shamir backup / hardware backup / güvenli kasalar (SHOULD)
- Yedekler coğrafi olarak ayrılmalı (SHOULD)

### 2.3 Erişim kontrolü
- Cüzdan erişimleri kişiye değil role bağlı olmalı (MUST).
- Personel ayrılışında erişimler anında kaldırılmalı (MUST).

---

## 3) Rol atama standardı (prod)

### 3.1 GRUSHToken
- DEFAULT_ADMIN_ROLE -> Governance Timelock
- MINTER_ROLE -> Issuance Multisig
- BURNER_ROLE -> RedemptionGateway (MUST) + (opsiyonel) Ops Multisig
- PAUSER_ROLE -> Security Multisig

### 3.2 ReserveRegistry
- DEFAULT_ADMIN_ROLE -> Governance Timelock
- SIGNER_ADMIN_ROLE -> Security/Governance (tercihen timelock)
- PUBLISHER_ROLE -> Publisher service multisig
- PAUSER_ROLE -> Security Multisig
- isAllowedSigner -> Attestation signer key’leri (HSM/MPC)

### 3.3 RedemptionGateway
- DEFAULT_ADMIN_ROLE -> Governance Timelock
- OPERATOR_ROLE -> Redemption Ops Multisig
- PAUSER_ROLE -> Security Multisig

---

## 4) Attestation signing operasyonu

### 4.1 İmzalama akışı (öneri)
1. Off-chain “bar list” dosyası üretilir
2. Leaf format + merkle root hesaplanır
3. `barListHash = keccak256(fileBytes)`
4. Attestation payload oluşturulur (reportId, asOfTimestamp, attestedFineGoldGrams, merkleRoot, barListHash)
5. HSM/MPC signer EIP-712 imza üretir
6. Publisher, `publishAttestation(...)` ile zincire yazar

### 4.2 Signer rotation
- Yeni signer ekle: `setAllowedSigner(newSigner, true)`
- Eski signer’ı kaldır: `setAllowedSigner(oldSigner, false)`
- Rotation kayıtları değişiklik yönetimi sisteminde tutulmalı (MUST)

---

## 5) Incident response (sızıntı / şüpheli işlem)

### 5.1 Hızlı aksiyonlar (MUST)
- Şüpheli durumda ilgili kontrat(lar) pause edilir:
  - GRUSHToken.pause()
  - ReserveRegistry.pause()
  - RedemptionGateway.pause()

### 5.2 Yetki iptali ve rotation
- Compromised rol sahibi adresin rolü revoke edilir (governance/timelock prosedürü)
- ReserveRegistry signer allowlist’ten compromised signer kaldırılır
- Yeni anahtarlar üretilir ve roller yeniden atanır

### 5.3 İletişim
- Olay zaman çizelgesi (timestamp), etkilenen adresler, alınan aksiyonlar kayıt altına alınır (MUST)
- Kullanıcı iletişim planı hazırlanır (SHOULD)

---

## 6) Operasyonel standartlar

### 6.1 Değişiklik yönetimi
- Rol ataması, signer allowlist değişimi, publisher değişimi:
  - Ticket + reviewer + onay kaydı (MUST)

### 6.2 Logging & monitoring
- Event izleme:
  - AttestationPublished
  - RedemptionRequested/Cancelled/Rejected/Fulfilled
  - Pause/Unpause eventleri (OZ)
- Alarm kuralları:
  - Beklenmedik mint/burn
  - Anormal redemption hacmi
  - Yetkisiz rol denemeleri (revert patternleri)

### 6.3 Ortam ayrımı
- Dev / test / prod anahtarları kesin ayrılmalı (MUST).
- Prod anahtarları testte kullanılmamalı (MUST NOT).

---

## 7) Checklist (prod go-live)

- [ ] Governance timelock ve multisig kuruldu
- [ ] Role dağıtımı dokümante edildi
- [ ] RedemptionGateway’e BURNER_ROLE verildi (GRUSHToken)
- [ ] ReserveRegistry signer allowlist doğrulandı
- [ ] Publisher ve signer key’leri ayrı tutuldu
- [ ] Incident runbook + 24/7 erişim planı hazır
- [ ] Monitoring + alerting aktif
