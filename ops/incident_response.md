# GRUSH Incident Response Plan (IRP) v0.1

Bu doküman, GRUSH v0.1 sisteminde güvenlik/operasyon/uyum kaynaklı olaylara (incident) hızlı, ölçülebilir ve kanıtlanabilir şekilde müdahale etmek için standart prosedürdür.

Kapsam:
- On-chain: GRUSHToken, ReserveRegistry, RedemptionGateway (ve ilgili admin/role mekanizmaları)
- Off-chain: PoR pipeline (bar list → leaf → Merkle → attestation), key management, custody, redemption operasyonu, kullanıcı verisi (PII), şeffaflık arşivi

Bu doküman “nasıl saldırılır” anlatmaz; yalnızca savunma ve müdahale prosedürüdür.

---

## 1) Amaç ve İlkeler

Amaç:
- Kullanıcı zararını minimize etmek
- Rezerv/PoR bütünlüğünü korumak
- Yetkisiz mint/burn/role değişimi gibi kritik eylemleri durdurmak
- Olayı hızlı tespit etmek, kanıt toplamak, kök nedeni bulmak ve tekrarını engellemek
- Kamu iletişimini tek kanaldan ve doğrulanabilir kanıtla yapmak

İlkeler:
- Güvenlik > süreklilik: Şüphede kalırsan “dur” (pause) tarafını seç.
- Tek kaynaklı gerçek: “Olay zaman çizelgesi” tek bir incident dosyasında tutulur.
- Kanıtı bozma: On-chain kanıt + off-chain loglar değiştirilemez şekilde saklanır.
- Minimum açıklama değil, doğru açıklama: Kamu mesajları kanıta dayanır, spekülasyon içermez.

---

## 2) Tanımlar

- **Incident (Olay):** Güvenlik/operasyon/uyum ihlali veya bu yönde güçlü şüphe.
- **Near-miss:** Zarar oluşmadan önce engellenen olay.
- **Pause:** Kontratların kritik fonksiyonlarını durdurma (token transfer/mint/burn/redemption/attestation publish vb. tasarıma göre).
- **Signer (Attestation):** ReserveRegistry’de attestation imzalayan anahtar(lar).
- **Admin/Multisig:** Kontrat rollerini ve kritik parametreleri yönetebilen yetkili cüzdan(lar).
- **Timelock:** Kritik yönetim işlemlerine gecikme uygulayan mekanizma (varsa).

---

## 3) Şiddet Seviyeleri (Severity)

### SEV-1 (Kritik)
- Yetkisiz mint/burn veya yetki ele geçirilmesi şüphesi
- Attestation signer kompromizi veya sahte attestation publish
- Custody/rezerv açığına dair kuvvetli kanıt
- Kullanıcı fonlarının/itfa sürecinin doğrudan tehlikede olması
Hedef süreler: Tespit ≤ 15 dk, İlk aksiyon ≤ 30 dk, İlk kamu notu ≤ 2 saat

### SEV-2 (Yüksek)
- PoR pipeline bütünlüğü şüpheli (root uyuşmazlığı, leaf canonicalization bug)
- Indexer/UI yanlış “latest attestation” gösterimi yaygın etkili
- Redemption operasyonunda sistematik suistimal / SLA çöküşü
Hedef: İlk aksiyon ≤ 2 saat, kamu notu ≤ 24 saat

### SEV-3 (Orta)
- Sınırlı kapsamlı servis kesintisi, tekil müşteri olayı, yanlış konfigürasyon
Hedef: 1 iş günü içinde stabilizasyon

### SEV-4 (Düşük)
- Dokümantasyon hatası, küçük izleme/alert iyileştirmeleri

---

## 4) Roller ve Yetkiler (RACI)

Bu bölüm “gerçek isimler” değil rol tanımıdır. Operasyonda karşılık gelen kişi/ekip ayrı listede tutulur.

- **IC (Incident Commander):** Olayın sahibi; karar alır, görev dağıtır, zaman çizelgesini yönetir.
- **On-chain Lead:** Kontrat aksiyonları (pause/unpause, role revoke, signer allowlist değişimi, acil parametreler).
- **Off-chain/Infra Lead:** Pipeline, servisler, CI/CD, erişimler, loglar.
- **Custody Liaison:** Custodian/auditor ile iletişim, rezerv kanıtları.
- **Comms Lead:** Tek kamu iletişim kanalı, metin onayı, soru-cevap.
- **Legal/Compliance:** Regülatif bildirim, PII ihlali, sözleşmesel yükümlülükler.
- **Scribe:** Olay günlüğü ve kanıt envanteri.

Yetki kuralı:
- SEV-1’de **pause** ve **signer revoke** gibi kararlar “IC + On-chain Lead” birlikte tetiklenir.
- Eğer timelock gecikmesi acil aksiyonları engelliyorsa “emergency path” (tasarıma bağlı) uygulanır; yoksa “pause + migration” planına geçilir.

---

## 5) Tetikleyiciler ve İzleme (Detection)

Minimum izleme seti:
- totalSupply vs son attestedFineGoldGrams fark alarmı
- Mint/Burn event alarmı (beklenmeyen çağrılar)
- RoleGranted/RoleRevoked/SignerChanged event alarmı
- AttestationPublished frekansı ve signer adresi alarmı
- PoR pipeline: schema validate fail / root mismatch / hash mismatch alarmı
- Redemption: reject/fulfill anomali, bekleyen talep yığılması, SLA aşımı
- PII sistemleri: yetkisiz erişim, veri dışa aktarım anomalisi

Her alarm şu 5 bilgiyi üretmeli:
- Zaman (UTC), zincir/blok (varsa), etkilenen bileşen, ilk bulgu, kanıt linki (tx hash / log snapshot)

---

## 6) İlk 30 Dakika: Triage Checklist (SEV-1/2)

1) **Incident ID aç**: `INC-YYYYMMDD-###`
2) **Scribe** zaman çizelgesi başlatır (dakika dakika)
3) Etki değerlendirmesi:
   - On-chain mi? Off-chain mi? Custody mi?
   - Kullanıcı fonu/itfa etkisi var mı?
4) Kanıt topla (değiştirmeden):
   - Tx hash/event log, RPC çıktısı, servis log snapshot, pipeline çıktıları
5) İlk karar:
   - “Pause gerekir mi?” (bkz. Bölüm 7)
   - “Signer revoke gerekir mi?”
6) İletişim:
   - İç kanalda durum notu (5 cümle): ne oldu, ne bilmiyoruz, ne yaptık, sırada ne var, ETA yok.

---

## 7) Pause / Unpause Politikası (Normatif)

### 7.1 Pause tetikleme kriterleri (PAUSE = EVET)
Aşağıdakilerden **herhangi biri** varsa PAUSE:
- Yetkisiz mint/burn şüphesi veya doğrulanmış olay
- Admin/role değişimi beklenmiyorsa (özellikle signer allowlist, admin role)
- Sahte/şüpheli attestation publish
- PoR root/leaf canonicalization hatası nedeniyle doğrulanabilirlik kaybı
- Redemption akışında fon/rezerv kaybı riski
- Kritik anahtar kompromizi (multisig signer veya attestation signer)

### 7.2 Pause nasıl uygulanır (genel)
Not: Rol/fonksiyon isimleri kontrata göre değişebilir.
- Token: transfer/mint/burn kısıtlanıyorsa ilgili pause fonksiyonu
- Registry: yeni attestation publish’i durdurma + signer revoke
- Gateway: yeni redemption request kabulünü durdurma, gerekirse fulfill/burn akışını durdurma

### 7.3 Unpause kriterleri (UNPAUSE = SADECE ŞARTLAR SAĞLANINCA)
Unpause için **hepsi** gerekir:
- Kök neden belirlendi ve kontrol altına alındı
- Kompromize anahtarlar rotate edildi / revoke edildi
- Zarar kapsamı netleşti (supply/rezerv, kullanıcı etki listesi)
- Yeni attestation veya düzeltici sürüm yayımlandı (gerekirse)
- Kamuya “ne oldu + ne değişti + kullanıcı ne yapmalı” net açıklama hazır

---

## 8) Olay Tipleri ve Runbook’lar

Her runbook: Trigger → Immediate Actions → Containment → Eradication → Recovery → Evidence

### RB-01: Yetkisiz Mint/Burn (SEV-1)
Trigger:
- Beklenmeyen Mint/Burn event veya supply artışı/azalışı
Immediate Actions:
- PAUSE (Token + Gateway, tasarıma göre)
- Admin/role değişikliklerini incele (RoleGranted/Revoked)
Containment:
- Şüpheli admin/signer adreslerini izole et (revoke/rotate)
- Zincir üstü izleme: yeni mint denemeleri
Eradication:
- Root cause: compromised multisig? script leak? role misconfig?
Recovery:
- Gerekirse yeni kontrat deploy + migration planı
Evidence:
- Tx hash’ler, event log export, multisig tx kayıtları, erişim logları

### RB-02: Attestation Signer Kompromizi / Sahte Attestation (SEV-1)
Trigger:
- AttestationPublished ama signer beklenen değil / içerik tutarsız
Immediate Actions:
- Registry’de signer revoke/denylist (tasarıma göre)
- PAUSE (özellikle attestation’a bağlı akışlar)
Containment:
- Yeni attestation publish kanalını kapat
- Off-chain signing sistemlerini izolasyon altına al
Eradication:
- Key rotation (HSM/MPC/threshold), yeni signer allowlist
Recovery:
- Doğru snapshot ile yeni attestation publish
Evidence:
- Sahte attestation payload, recovered signer, pipeline çıktıları, signing host logları

### RB-03: PoR Root/Leaf Uyumsuzluğu (SEV-2 → SEV-1’e yükselebilir)
Trigger:
- Aynı snapshot farklı root üretiyor / doğrulayıcılar uyuşmuyor
Immediate Actions:
- Attestation publish’i durdur
- Son “iyi” snapshot/root’u işaretle (public açıklama olmadan önce doğrula)
Containment:
- Tek referans implementasyon + test vector doğrulaması
Eradication:
- Canonicalization bug fix + leaf_format standard güncellemesi (version bump)
Recovery:
- Yeni standarda göre root üret + yayınla; eski standardı arşivle
Evidence:
- Snapshot hash, eski/yeni root, test vector sonuçları, kod commitleri

### RB-04: Custody/Rezerv Açığı Şüphesi (SEV-1)
Trigger:
- Custodian doğrulaması başarısız, bar list tutarsız, denetçi red’i
Immediate Actions:
- PAUSE (Token + Gateway)
- Custodian & auditor acil çağrı
Containment:
- Yeni redemption durdur; mevcut talepleri “hold” statüsüne al
Eradication:
- Reconciliation, fiziksel sayım, hukuki adımlar
Recovery:
- Rezerv yeniden tesis edilmeden unpause yok
Evidence:
- Custody receipt, audit raporu, iletişim kayıtları, bar list snapshot arşivi

### RB-05: Redemption Operasyon Suistimali / SLA Çöküşü (SEV-2)
Trigger:
- Reject/fulfill anomalisi, bekleyen talepler birikiyor
Immediate Actions:
- Gateway yeni request kabulünü geçici durdur (gerekirse)
- Operasyon ekibi erişimlerini gözden geçir
Containment:
- 4-eyes kontrol, ikinci onay mekanizması
Eradication:
- SOP düzeltme, personel/erişim değişimi
Recovery:
- Backlog temizleme planı, kullanıcı bilgilendirme
Evidence:
- requestId timeline, ops case logları, fulfillment kayıtları

### RB-06: PII / KYC Veri İhlali (SEV-1/2)
Trigger:
- Yetkisiz veri erişimi, sızıntı göstergesi
Immediate Actions:
- Etkilenen sistemleri izole et, erişimleri kes
- Legal/Compliance’ı anında dahil et
Containment:
- Token/kontrat aksiyonu gerekmeyebilir; ancak redemption süreci durdurulabilir
Eradication:
- Anahtar/şifre rotasyonu, zafiyet kapatma, forensics
Recovery:
- Bildirim yükümlülükleri, kullanıcı bilgilendirme, güvenlik iyileştirmeleri
Evidence:
- Access logs, exfil göstergeleri, forensics raporu

### RB-07: Indexer/UI Yanlış Durum Gösterimi (SEV-2)
Trigger:
- “Latest attestation” yanlış seçiliyor, reorg etkisi
Immediate Actions:
- UI’da finality window uygulaması / uyarı banner
Containment:
- Re-index; multi-node doğrulama
Eradication:
- Canonical chain doğrulama, veri doğrulama imzaları
Recovery:
- Doğrulanmış doğru duruma dön
Evidence:
- Block hash, indexer logları, UI sürüm değişimi

---

## 9) İletişim Planı (Internal + Public)

### 9.1 İç iletişim
- Tek incident kanalı
- Her 30–60 dk durum güncellemesi (SEV-1)
- “Bilmiyoruz”u yaz: spekülasyon yok

### 9.2 Kamu iletişimi
Tek kanal, tek metin sahibi: Comms Lead.
İlk kamu notu formatı:
- Ne oldu (kanıta dayalı)
- Etki: token transfer/itfa/attestation durumu
- Kullanıcı ne yapmalı / yapmamalı
- Bir sonraki güncelleme penceresi (süre vermeden “gün içinde/24 saat içinde” gibi)

Kamu mesajı yayımlanmadan önce:
- IC + Legal/Compliance onayı
- Kanıt referansları (tx hash, snapshot hash) hazır

---

## 10) Kanıt Toplama ve Saklama (Evidence Handling)

- On-chain: tx hash, event log export, blok numarası, chainId
- Off-chain: log snapshot (immutable), pipeline çıktıları, checksum’lar
- Snapshot arşivi: bar list dosyası + hash + timestamp + kim üretti
- Erişim kayıtları: IAM, ssh, CI/CD, secrets manager

Kural:
- “Kanıt” klasörüne sadece ekleme (append-only). Silme yok.

---

## 11) Post-Incident (Kapanış ve Kalıcı Önlem)

Kapanış kriterleri:
- Root cause net + kalıcı fix planı commit edilmiş
- İzleme/alert gap’leri kapatılmış
- Kullanıcı etki analizi tamamlanmış
- Postmortem yayınlanmış (gizli bölümler ayrılabilir)

Postmortem şablonu:
- Özet
- Zaman çizelgesi
- Kök neden
- Etki
- Neyi iyi yaptık / neyi kötü yaptık
- Aksiyon listesi (owner + tarih)

---

## 12) Tatbikat ve Bakım

- Ayda 1 tabletop (SEV-1 senaryosu)
- Çeyrekte 1 teknik drill (pause/unpause simülasyonu)
- Her release’te runbook uyumluluk kontrolü

---

## Ek A: Hızlı Karar Matrisi

- Yetkisiz mint/burn şüphesi → PAUSE + multisig incele
- Sahte attestation şüphesi → signer revoke + attestation publish durdur
- PoR root uyuşmazlığı → publish durdur + test vector doğrula
- Custody şüphesi → PAUSE + custody/auditor acil doğrulama
- PII ihlali → sistem izolasyonu + legal/compliance + redemption gerekirse durdur

---

## Ek B: Incident Günlüğü Başlığı (Scribe için)

INC-YYYYMMDD-###  
Severity:  
Başlangıç zamanı (UTC):  
Tespit eden:  
İlk bulgu:  
Etkilenen bileşenler:  
Alınan aksiyonlar:  
Kanıt linkleri:  
Bir sonraki adımlar:
