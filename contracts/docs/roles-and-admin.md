# Roles & Admin Model v0.1 (GRUSH Contracts)

Bu doküman GRUSH kontratlarının rol tabanlı yetkilendirmesini (AccessControl) ve operasyonel önerileri tanımlar.

Kontratlar:
- `GRUSHToken` — `contracts/src/GRUSHToken.sol`
- `ReserveRegistry` — `contracts/src/ReserveRegistry.sol`
- `RedemptionGateway` — `contracts/src/RedemptionGateway.sol`

Normatif anahtar kelimeler: **MUST**, **MUST NOT**, **SHOULD**, **MAY**.

---

## 1) Genel ilkeler

### 1.1 Least privilege
- Her rol sadece ihtiyaç duyduğu yetkiyi almalıdır (MUST).
- Tek bir cüzdana tüm roller verilmemelidir (SHOULD).

### 1.2 Separation of duties
Ayrı fonksiyonlar ayrı aktörlerde olmalıdır:
- Mint (issuance) ≠ Redemption operator ≠ Attestation signer admin ≠ Pauser

### 1.3 Anahtar türleri
- DEFAULT_ADMIN_ROLE: tercihen **timelock + multisig**
- Operasyon rolleri: tercihen **multisig (2/3 veya 3/5)**
- Attestation signing key: tercihen **HSM/MPC** (EOA olabilir ama kurumsal güvenlik gerekir)

---

## 2) GRUSHToken rolleri

### 2.1 DEFAULT_ADMIN_ROLE
Yetkiler:
- Rol grant/revoke
- Tüm role yönetimi

Öneri:
- Timelock ile yönet (MUST for production).
- Günlük operasyon için kullanılmamalı.

### 2.2 MINTER_ROLE
Yetkiler:
- `mint(to, amount)`

Öneri:
- Issuance ops multisig.
- Mint öncesi off-chain kontrol listesi (rezerv allocate + KYC + internal approvals).

### 2.3 BURNER_ROLE
Yetkiler:
- `burn(amount)` (kendi bakiyesinden)
- `burnFrom(from, amount)` (allowance ile)

Öneri:
- `RedemptionGateway` adresine BURNER_ROLE verilmelidir (MUST) çünkü fulfill sırasında escrowed token’ı yakar.
- Ek olarak ops multisig de burner olabilir (gerekiyorsa).

### 2.4 PAUSER_ROLE
Yetkiler:
- `pause()`, `unpause()`
- pause açıkken transfer/mint/burn bloklanır (`_update` hook)

Öneri:
- Security multisig.
- Pause/unpause olayları runbook ile yönetilmeli.

---

## 3) ReserveRegistry rolleri

### 3.1 DEFAULT_ADMIN_ROLE
Yetkiler:
- Rol grant/revoke

Öneri:
- Timelock.

### 3.2 SIGNER_ADMIN_ROLE
Yetkiler:
- `setAllowedSigner(signer, allowed)`
- `setAllowedSigners(signers[], allowed[])`

Öneri:
- Attestation signer allowlist yönetimi ayrı tutulmalı (SHOULD).
- Signer rotation ve incident response bu rol üzerinden yapılır.

### 3.3 PUBLISHER_ROLE
Yetkiler:
- `publishAttestation(...)`

Not:
- `publishAttestation` imzayı doğrular; signer allowlist’te değilse işlem revert eder.
- Publisher spam/state bloat kontrolü için var.

Öneri:
- Publisher, attestation paketini zincire basan ops servisi/multisig olabilir.

### 3.4 PAUSER_ROLE
Yetkiler:
- `pause()`, `unpause()`

---

## 4) RedemptionGateway rolleri

### 4.1 DEFAULT_ADMIN_ROLE
Yetkiler:
- Rol grant/revoke

Öneri:
- Timelock.

### 4.2 OPERATOR_ROLE
Yetkiler:
- `rejectRedemption(requestId, reasonHash)`
- `fulfillRedemption(requestId, fulfillmentRef)`

Öneri:
- Operasyon multisig.
- Her reject/fulfill off-chain case id ile bağlanmalı (reasonHash / fulfillmentRef).

### 4.3 PAUSER_ROLE
Yetkiler:
- `pause()`, `unpause()`

---

## 5) Önerilen rol dağıtımı (prod)

Aşağıdaki şablon “öneri”dir; adresler deploy sonrası doldurulur.

- Governance Timelock:
  - GRUSHToken.DEFAULT_ADMIN_ROLE
  - ReserveRegistry.DEFAULT_ADMIN_ROLE
  - RedemptionGateway.DEFAULT_ADMIN_ROLE

- Issuance Multisig:
  - GRUSHToken.MINTER_ROLE

- Redemption Ops Multisig:
  - RedemptionGateway.OPERATOR_ROLE
  - (opsiyonel) GRUSHToken.BURNER_ROLE (acil müdahale gerekiyorsa)

- Security Multisig:
  - GRUSHToken.PAUSER_ROLE
  - ReserveRegistry.PAUSER_ROLE
  - RedemptionGateway.PAUSER_ROLE

- Attestation Signer Admin (MPC/HSM yönetimi):
  - ReserveRegistry.SIGNER_ADMIN_ROLE

- Attestation Publisher (servis/multisig):
  - ReserveRegistry.PUBLISHER_ROLE

- RedemptionGateway kontratı:
  - GRUSHToken.BURNER_ROLE (MUST)

---

## 6) Acil durum (incident) prosedürü (özet)

Bir anahtar sızıntısı/şüpheli işlem halinde:
1. İlgili kontratı pause et (PAUSER_ROLE) (MUST)
2. Yetkili rolü revoke et (DEFAULT_ADMIN_ROLE / timelock prosedürü)
3. ReserveRegistry’de signer allowlist’ten compromised signer’ı kaldır (SIGNER_ADMIN_ROLE)
4. Yeni signer/publisher key set et
5. Olay raporu ve post-mortem yayınla (ops süreç)
