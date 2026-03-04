# Goldenrush (Grush) — STATUS / Module Readiness Index (MRI)

## Seviye tanımı (L0–L3)
- **L0**: İskelet var (klasör/0-byte/TODO). Ürün akışı yok.
- **L1**: Spec + minimum çalışan demo (lokal doğrulama/örnek çıktı). Kenar durumları zayıf.
- **L2**: Uçtan uca çalışır (Sepolia dahil), temel testler + runbook + CI gate.
- **L3**: Prod-sert (threat model, key policy, denetim/audit izi, ops guard’lar, incident response).

## MRI Tablosu
| Modül | Owner | Seviye | Next concrete output | Not |
|---|---|---:|---|---|
| contracts | TBD | L2 | A3: publishAttestation event/state cross-check + allowlist negatif test | deploy/handover runner var |
| por | TBD | L1 | A1: JSON string + BigInt parse; A2: tek komut pipeline | şu an sayı tipleri kırılgan |
| tools | TBD | L1 | A2: por:pipeline wrapper + latest pointer; B2: scheduled verify | verify script var |
| ops | TBD | L0 | ops/runbook: sepolia publish + mainnet handover + incident response | skeleton |
| compliance | TBD | L0 | transparency policy + yayın sıklığı + record retention netleştirme | dosyaların çoğu boş |
| legal | TBD | L0 | key/custody sözleşme şablonları ve yayın politikası bağlama | skeleton |
| apps/explorer | TBD | L0 | Explorer MVP: latest göster + verify sonucu + receipt link | skeleton |
| infra | TBD | L0 | CI scheduled + deploy guard ortamları | skeleton |

## “Şimdi” (net sıradaki 3 PR)
- [ ] PR-0: MRI + deterministik kurulum + artifact hijyeni
- [ ] PR-A1: Büyük sayı sertleştirme (JSON string + BigInt)
- [ ] PR-A2: por:pipeline tek komut + output standardı + latest pointer