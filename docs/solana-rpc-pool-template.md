# Template RPC Pool Solana

Gunakan **Replit Secrets**, bukan file kode atau chat, untuk menyimpan endpoint RPC.

## Secret utama

**Name**

```text
SOLANA_RPC_URLS
```

**Value — template**

```text
https://your-primary-rpc-provider.example/?api-key=YOUR_PROVIDER_KEY
https://your-secondary-rpc-provider.example/?api-key=YOUR_PROVIDER_KEY
https://your-tertiary-rpc-provider.example/?api-key=YOUR_PROVIDER_KEY
```

Sistem juga menerima format satu baris:

```text
https://your-primary-rpc-provider.example/?api-key=YOUR_PROVIDER_KEY,https://your-secondary-rpc-provider.example/?api-key=YOUR_PROVIDER_KEY,https://your-tertiary-rpc-provider.example/?api-key=YOUR_PROVIDER_KEY
```

## Fallback kompatibilitas

Secret lama berikut masih didukung:

```text
SOLANA_RPC_URL
```

Jika `SOLANA_RPC_URLS` dan `SOLANA_RPC_URL` sama-sama tersedia, keduanya digabungkan dan URL duplikat dihapus.

## Rekomendasi pengisian

- Gunakan 2–4 endpoint dari provider atau akun RPC yang berbeda.
- Letakkan endpoint paling stabil di urutan pertama.
- Jangan gunakan placeholder di atas sebagai URL sungguhan.
- Jangan commit API key atau URL berisi credential ke repository.
- Jangan mengirim URL credential melalui chat.

## Perilaku failover

Radar akan:

1. Mencoba endpoint sehat secara bergiliran.
2. Berpindah endpoint saat terjadi timeout, HTTP 429, atau HTTP 5xx.
3. Memberi cooldown 30 detik pada endpoint yang gagal berulang.
4. Mencoba maksimal dua kali per endpoint agar tidak memperburuk rate limit.
5. Tetap menolak kandidat secara fail-closed jika semua endpoint tidak tersedia.

## Format provider berlabel

Provider dapat diberi label agar status health mudah dibaca. Label hanya metadata
lokal; URL tetap disimpan sebagai secret:

```text
HELIUS=https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY
ZAN=https://api.zan.top/node/v1/solana/mainnet/YOUR_ZAN_KEY
QUICKNODE=https://your-quicknode-endpoint.example
```

Format JSON juga didukung:

```json
{
  "HELIUS": "https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_KEY",
  "ZAN": "https://api.zan.top/node/v1/solana/mainnet/YOUR_ZAN_KEY"
}
```

URL dashboard atau halaman pengelolaan API key akan ditolak; gunakan endpoint
JSON-RPC langsung dari dokumentasi provider.

Setelah secret disimpan, restart workflow **Start application**. Status audit akan menampilkan jumlah endpoint yang terdeteksi tanpa menampilkan URL rahasianya.