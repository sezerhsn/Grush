# Contract Specification v0.1 (GRUSH)

Bu doküman v0.1 kontratlarının davranışını, dış arayüzünü, olaylarını ve temel invariants’larını tanımlar.

Kontratlar:
- `GRUSHToken` — ERC20 + Permit + AccessControl + Pausable
- `ReserveRegistry` — EIP712 imzalı PoR attestation registry
- `RedemptionGateway` — Redemption request audit log + escrow/burn

İlgili arayüzler:
- `IReserveRegistry` — `contracts/src/interfaces/IReserveRegistry.sol`
- `IRedemptionGateway` — `contracts/src/interfaces/IRedemptionGateway.sol`

---

## 0) Genel varsayımlar

- Solidity: `^0.8.24`
- OpenZeppelin v5 kullanımı
- Token birimi: 18 decimals
- “1 GRUSH = 1 gram fine gold” semantiği ops süreçleriyle korunur.
- v0.1’de fee enforcement on-chain değildir (`docs/fee_model.md`).

---

## 1) GRUSHToken

### 1.1 Amaç
GRUSH tokenı ERC-20’dur ve Permit (EIP-2612) desteği sağlar. Mint ve burn AccessControl ile kısıtlanır. Pause açıkken transfer/mint/burn engellenir.

### 1.2 Roller
- `DEFAULT_ADMIN_ROLE`: rol yönetimi
- `MINTER_ROLE`: `mint`
- `BURNER_ROLE`: `burn`, `burnFrom`
- `PAUSER_ROLE`: `pause/unpause`

### 1.3 Dış fonksiyonlar
- `mint(address to, uint256 amount)` — only MINTER_ROLE
- `burn(uint256 amount)` — only BURNER_ROLE
- `burnFrom(address from, uint256 amount)` — only BURNER_ROLE, allowance tüketir
- `pause()` / `unpause()` — only PAUSER_ROLE
- ERC20 + ERC20Permit standart fonksiyonları

### 1.4 Olaylar
- `Minted(to, amount)`
- `Burned(from, amount)`
- `BurnedFrom(from, by, amount)`
- ERC20 `Transfer` (mint/burn dahil)

### 1.5 Invariants
- Pause açıkken token hareketi yok (transfer/mint/burn revert).
- Mint yalnız MINTER_ROLE ile.
- Burn yalnız BURNER_ROLE ile.

---

## 2) ReserveRegistry

### 2.1 Amaç
Zincir üstünde “Proof of Reserves” attestation kayıtları tutar. Attestation, EIP-712 typed data ile imzalanır ve allowlist signer ile doğrulanır.

### 2.2 Roller
- `DEFAULT_ADMIN_ROLE`: rol yönetimi
- `SIGNER_ADMIN_ROLE`: allowlist signer yönetimi
- `PUBLISHER_ROLE`: attestation publish (spam/bloat kontrolü)
- `PAUSER_ROLE`: pause/unpause

### 2.3 Attestation modeli
Typed data:
- `reportId: bytes32`
- `asOfTimestamp: uint64`
- `attestedFineGoldGrams: uint256`
- `merkleRoot: bytes32`
- `barListHash: bytes32`

Domain:
- name: `"GRUSH Reserve Attestation"`
- version: `"1"`
- chainId: current chain id
- verifyingContract: registry address

### 2.4 Dış fonksiyonlar
- `setAllowedSigner(address signer, bool allowed)` — only SIGNER_ADMIN_ROLE
- `setAllowedSigners(address[] signers, bool[] allowed)` — only SIGNER_ADMIN_ROLE
- `publishAttestation(...) returns (address recoveredSigner)` — only PUBLISHER_ROLE, whenNotPaused
- `exists(reportId) -> bool`
- `getAttestation(reportId) -> AttestationRecord`
- `latestReportId()`, `latestAsOfTimestamp()`
- `latestAttestation() -> (reportId, AttestationRecord)`
- `reportIdsCount() -> uint256`
- `getReportIds(start, count) -> bytes32[]` (pagination)
  - `start >= n` ise boş array döndürür.

### 2.5 Olaylar
- `AttestationPublished(...)`
- `AllowedSignerUpdated(signer, allowed)`

### 2.6 Invariants
- Aynı `reportId` ikinci kez publish edilemez.
- `publishAttestation` yalnız allowlist signer imzasıyla kabul edilir.
- `latestReportId` en büyük `asOfTimestamp`’e göre güncellenir.

---

## 3) RedemptionGateway

### 3.1 Amaç
Redemption taleplerini zincir üstünde audit edilebilir şekilde loglar.
- Kullanıcı GRUSH’ı escrow eder.
- Kullanıcı Requested iken iptal edebilir.
- Operator reject edebilir (token iade).
- Operator fulfill edebilir (escrowed token yakılır).

PII zincire yazılmaz; `destinationHash` sadece off-chain pointer/commitment’tır.

### 3.2 Roller
- `DEFAULT_ADMIN_ROLE`: rol yönetimi
- `OPERATOR_ROLE`: reject/fulfill
- `PAUSER_ROLE`: pause/unpause

### 3.3 Status state machine
`Status` enum:
- None(0)
- Requested(1)
- Cancelled(2)
- Rejected(3)
- Fulfilled(4)

Geçişler:
- None -> Requested: `requestRedemption` / `requestRedemptionWithPermit`
- Requested -> Cancelled: `cancelRedemption` (only requester)
- Requested -> Rejected: `rejectRedemption` (only operator)
- Requested -> Fulfilled: `fulfillRedemption` (only operator)
Diğer geçişler revert.

### 3.4 requestId hesaplama
`requestId = keccak256( abi.encodePacked(address(this), chainid, requester, nonce, amount, destinationHash) )`

- nonce `userNonce[requester]` ile tutulur ve her request’te artar.

### 3.5 Dış fonksiyonlar
- `requestRedemption(amount, destinationHash) -> requestId`
- `requestRedemptionWithPermit(amount, destinationHash, deadline, v, r, s) -> requestId`
  - Token permit desteklemiyorsa `PermitNotSupported` revert.
- `cancelRedemption(requestId)`
- `rejectRedemption(requestId, reasonHash)`
- `fulfillRedemption(requestId, fulfillmentRef)`
  - Gateway, token üzerinde `burn(uint256)` çağırır.
  - Bu nedenle **GRUSHToken.BURNER_ROLE gateway’e verilmiş olmalıdır**.
- Views:
  - `getRequest(requestId)`
  - `statusOf(requestId)`
  - `escrowBalance()`

### 3.6 Olaylar
- `RedemptionRequested`
- `RedemptionCancelled`
- `RedemptionRejected`
- `RedemptionFulfilled`

### 3.7 Invariants
- Pause açıkken request/cancel/reject/fulfill revert.
- ReentrancyGuard aktif.
- Requested olmayan statüde cancel/reject/fulfill olmaz.
- Escrow muhasebesi `totalEscrowed` best-effort (transfer başarısızlığı revert).

---

## 4) Güvenlik notları (v0.1)

- Privileged roller multisig/timelock ile yönetilmelidir.
- Attestation signer key HSM/MPC ile korunmalıdır.
- Pause mekanizması runbook ile işletilmelidir.
- Upgradeability yoksa (proxy yok): yeni sürüm için yeni kontrat deploy + rol geçiş planı gerekir.
