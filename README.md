# DEM 3D Viewer

Viewer lokal untuk merender GeoTIFF/heightmap DEM sebagai terrain 3D dan menampilkan GeoTIFF RGB, orthophoto, citra satelit, atau peta sebagai texture di permukaannya.

## Fokus v2.5.5

Versi ini memprioritaskan dua workflow produk:

1. **Orthomosaic / Mosaic:** foto drone mentah dikirim dari UI ke NodeODM/OpenDroneMap lokal. Aplikasi membuat task, memantau progress, lalu menyediakan unduhan orthophoto, DTM, DSM, dan semua output.
2. **Terrain-based Flood Risk:** DTM dibersihkan dari NoData, dihitung dengan Priority-Flood dan D8 flow accumulation, lalu diklasifikasikan menjadi Low, Medium, High, dan Critical.
3. **CRS geografis dan UTM:** metadata EPSG/GeoKeys dibaca otomatis sehingga slope, luas, panjang, hydrology, elevation profile, dan FPV memakai skala meter yang benar.
4. **Shapefile operasional:** satu ZIP berisi `.shp`, `.shx`, `.dbf`, dan `.prj` dapat dimuat sebagai batas blok, jalan, kanal, atau titik aset dan diselaraskan ke CRS DEM.
5. **Shapefile standalone:** paket Shapefile dapat dibuka lebih dahulu pada peta datar tanpa orthomosaic, DEM, atau DTM. Saat DEM dimuat kemudian, layer otomatis diproyeksikan dan didrape ke terrain.
6. **Globe WGS84:** Shapefile otomatis ditempatkan pada posisi longitude/latitude sebenarnya. Mode Globe menampilkan layer di permukaan bumi, sedangkan Globe 3D memberi extrusi visual pada polygon untuk inspeksi tanpa mengklaimnya sebagai elevasi terrain.
7. **Mapbox satellite globe:** mode Globe menggunakan Mapbox Standard Satellite, atmosphere, dan auto-focus ke extent Shapefile. Globe 3D menambahkan Mapbox Terrain-DEM serta kamera pitch untuk inspeksi regional.
8. **High-visibility boundary:** geometry jalan dan ring polygon dinormalisasi menjadi LineString khusus overlay. Garis digambar ulang oleh canvas transparan yang selalu berada di atas canvas Mapbox. Ketebalan menyesuaikan kepadatan: dataset di atas 5.000 ruas memakai skala 55% agar citra satelit tetap terbaca, sementara boundary kecil tetap lebih tegas. Tidak ada marker POI berkedip.
9. **Mapbox terrain untuk Globe 3D:** relief diambil dari Mapbox Terrain-DEM dengan vertical exaggeration 1,5×. Shapefile tetap berfungsi sebagai overlay lokasi; elevasi 3D tidak ditebak dari atribut garis.

## Menjalankan NodeODM

Docker diperlukan untuk memproses foto drone. Dari folder project:

```bash
docker compose -f docker-compose.nodeodm.yml up -d
npm install
npm run dev
```

Endpoint default UI adalah `/nodeodm`; Vite meneruskannya ke `http://127.0.0.1:3000`. Untuk NodeODM pada server lain, isi endpoint langsung di panel dan tambahkan token bila server mengaktifkan autentikasi.

Workflow:

```text
Foto drone → NodeODM → Orthophoto + DTM + DSM
                         ↓
                  load ke viewer
                         ↓
              NoData mask + Flood Risk
```

Target GSD default `7,5 cm/pixel` adalah resolusi output yang diminta ke ODM. Hasil sebenarnya tetap bergantung pada ketinggian terbang, sensor, overlap, fokus, GCP, dan kualitas foto sumber.

## Menjalankan

Pastikan Node.js 20 atau yang lebih baru sudah terpasang.

```bash
npm install
npm run dev
```

Untuk mode Globe, salin konfigurasi environment lalu isi public token Mapbox (`pk.`):

```bash
cp .env.example .env
```

```env
VITE_MAPBOX_ACCESS_TOKEN=pk.your_public_mapbox_token
```

Setelah mengubah `.env`, restart development server:

```bash
npm run dev
```

Buka alamat yang ditampilkan terminal, biasanya `http://localhost:5173`.

## Format input

### GeoTIFF DEM (disarankan)

- `.tif` atau `.tiff` satu band elevasi.
- Nilai elevasi asli dibaca langsung dari raster.
- Extent digunakan untuk memeriksa kesesuaian dengan texture.

### Heightmap DEM alternatif

- PNG, JPG, atau WebP grayscale.
- Hitam dianggap elevasi terendah.
- Putih dianggap elevasi tertinggi.
- Disarankan PNG 16-bit atau minimal PNG 8-bit, rasio dan extent harus sama dengan texture.

### Texture permukaan

- Orthophoto, citra satelit, atau hasil ekspor peta dari QGIS.
- GeoTIFF RGB, PNG, JPG, atau WebP.
- CRS, extent, crop, resolusi/aspect ratio, dan orientasinya harus sesuai dengan DEM.

Jika texture terbalik terhadap DEM, gunakan opsi **Balik texture vertikal**. Jika lembah justru menjadi gunung, aktifkan **Balik tinggi DEM**.

## Satu GeoTIFF dan auto detect

Jika hanya memiliki satu file, gunakan **Satu GeoTIFF · Auto detect**:

- TIFF RGB, palette, CMYK, YCbCr, atau file bernama `MOSAIC`/`ORTHO` diperlakukan sebagai orthomosaic. Warna diekstrak langsung dari band TIFF sebagai texture asli.
- TIFF satu band dengan penanda DEM/DTM/DSM/elevation diperlakukan sebagai elevasi.
- Jika hanya ada DEM satu band, viewer membuat visual hillshade/elevation. Ini bukan orthophoto asli.
- Jika hanya ada orthomosaic RGB, viewer menampilkannya secara datar sampai DEM/DTM yang sejajar dimuat. Orthomosaic tidak dapat menghasilkan elevasi 3D yang akurat sendirian.

## GeoTIFF besar / BigTIFF

Versi 2.0.0 dapat membuka GeoTIFF atau BigTIFF berukuran multi-GB tanpa menjalankan `file.arrayBuffer()` terhadap seluruh file. Loader membaca byte-range langsung dari `File/Blob`, memeriksa overview internal, lalu membuat raster kerja adaptif:

- DEM: maksimum sekitar 2 juta pixel untuk menjaga slope, contour, hydrology, pengukuran area, dan FPV tetap responsif.
- Orthomosaic/texture: maksimum sekitar 8 juta pixel dan mengikuti batas texture GPU sampai 4096 px per sisi.
- Jika TIFF memiliki internal overview/pyramid, level terdekat digunakan agar decoding lebih cepat.
- Informasi ukuran sumber, ukuran preview, ukuran file, layout tiled/striped, dan overview yang dipakai ditampilkan di panel.

File asli tetap berada di perangkat dan tidak diunggah. Untuk pengalaman paling cepat, gunakan tiled GeoTIFF atau Cloud Optimized GeoTIFF (COG) dengan internal overviews. TIFF striped tetap didukung, tetapi proses decode pertama dapat lebih lama.

Preview adaptif dipakai untuk visualisasi dan analisis interaktif. Nilai pada grid kerja mewakili hasil resampling dari sumber; pekerjaan yang membutuhkan resolusi pixel asli sebaiknya diekspor/diproses melalui pipeline COG bertile pada tahap production.

## Build production

Worker Mapbox dibundel sebagai ES module melalui `worker.format: 'es'` di
`vite.config.js`. Konfigurasi ini diperlukan karena entry ESM Mapbox memakai
code-splitting untuk worker internalnya.

```bash
npm run build
npm run preview
```

Output production berada di folder `dist`.

## Data contoh

Raster contoh tidak disimpan di Git agar repository tetap ringan. Gunakan pasangan DEM/DTM dan orthophoto sendiri dengan CRS serta extent yang sama. File yang sebelumnya disertakan memakai EPSG:4326; upload DEM ke **Heightmap DEM**, lalu orthophoto ke **Texture permukaan**.

## Terrain inspection

Setelah DEM dimuat, viewer menyediakan:

- Pergantian tampilan 2D dan 3D.
- Layer texture, elevation color, hillshade, slope, dan contour.
- Klik terrain untuk membaca longitude, latitude, elevasi, dan slope.
- Elevation profile dengan memilih dua titik pada terrain.
- Legenda otomatis berdasarkan rentang elevasi DEM.

Layer analisis dihitung lokal di browser; GeoTIFF tidak dikirim ke server.

## Import Shapefile ZIP

Upload langsung satu ZIP standar dengan komponen bernama sama. DEM/DTM dan orthomosaic bersifat opsional:

```text
batas_blok.shp
batas_blok.shx
batas_blok.dbf
batas_blok.prj
```

Viewer akan:

- menolak paket yang kehilangan salah satu komponen wajib;
- membaca geometry dan atribut DBF di browser;
- membaca proyeksi sumber dari PRJ melalui `shpjs`;
- mentransformasikan WGS84 hasil parsing ke CRS DEM melalui `proj4`;
- mendefinisikan otomatis WGS84 UTM zona `32601–32660` dan `32701–32760`;
- menggambar polygon, line, dan point mengikuti permukaan terrain;
- menghitung area, perimeter, elevasi, rata-rata slope, serta persentase High/Critical Flood Risk per polygon;
- mengekspor geometry yang sudah sejajar sebagai GeoJSON beserta CRS target.

Tanpa DEM, viewer memakai mode standalone WGS84 dan tetap menghitung luas serta perimeter polygon. Elevasi, rata-rata slope, dan persentase Flood Risk ditampilkan setelah DEM/DTM yang beririsan dimuat. Orthomosaic hanya diperlukan bila pengguna ingin melihat texture foto asli.

Setelah ZIP selesai dibaca, viewer otomatis membuka **Globe Standard** dan memusatkan kamera ke extent layer. Boundary digambar di atas Mapbox Standard Satellite menggunakan halo hitam, casing kuning, dan garis inti magenta. Gunakan **Globe 3D** untuk Mapbox Terrain-DEM dengan kamera perspektif. Mode globe memerlukan koneksi internet dan public Mapbox access token; Shapefile tetap diproses lokal di browser.

Layer projected di luar keluarga WGS84 UTM harus mempunyai definisi Proj4 yang tersedia atau dikonversi terlebih dahulu di QGIS. File `.prj` diwajibkan agar koordinat tidak diterka.

## Analisis hidrologi

Klik **Jalankan analisis hidrologi** setelah GeoTIFF DEM selesai dimuat. Viewer menghitung:

- Sink/depression filling menggunakan Priority-Flood.
- Arah aliran D8.
- Flow accumulation dan luas area hulu.
- Kandidat jalur air berdasarkan ambang area tangkapan.
- Kedalaman pengisian depression.
- Indeks flood risk awal dari accumulation, depression depth, dan slope.

Ambang jalur air dan kedalaman kritis dapat diubah dari panel. Layer `Flow`, `Depression`, dan `Flood risk` akan diperbarui otomatis.

> Hasil merupakan screening terrain, bukan simulasi hidraulik. Untuk desain drainase, validasi DTM, culvert, kanal, curah hujan, infiltrasi, dan elevasi outlet tetap diperlukan.

## Land suitability sprint 1–3

- **Slope suitability:** klasifikasi awal S1 (0–8°), S2 (>8–15°), S3 (>15–25°), dan N (>25°), statistik luas/persentase, inspeksi titik, serta ekspor CSV ringkasan.
- **Waterway extraction:** ekstraksi kandidat jalur air dari D8 flow accumulation. Ambang luas tangkapan dapat diubah, lalu hasil diekspor sebagai GeoJSON LineString untuk dibuka di QGIS.
- **Flood Risk screening:** skor 0–100 dan kelas Low, Medium, High, Critical berdasarkan flow accumulation, depression/fill depth, dan flat terrain. Bobot default 45/42/13 dapat disesuaikan dan dinormalisasi otomatis. Panel menampilkan luas per kelas, faktor dominan pada titik, dan ekspor CSV.

Ambang slope dan bobot flood adalah konfigurasi screening awal. Kalibrasikan terhadap SOP kebun dan data lapangan sebelum dipakai untuk keputusan desain.

## First Person terrain walkthrough

1. Klik satu titik pada terrain.
2. Pilih **View in person** pada popup POI.
3. Klik **Click to explore** untuk mengunci mouse seperti game FPS.
4. Gunakan `W`, `A`, `S`, `D` untuk berjalan, `Shift` untuk berlari, mouse untuk melihat sekeliling, dan `Esc` untuk melepas mouse. Pada layar sentuh, drag/swipe tetap dapat digunakan.
5. Klik **Exit person view** untuk kembali ke posisi serta mode kamera sebelumnya.

Mode ini membangun terrain terpisah dengan skala fisik dalam meter. Kamera memakai tinggi mata fisik 1,75 meter ditambah safety clearance adaptif sesuai resolusi raster, sehingga tidak memotong permukaan DEM kasar. Gerakan memakai acceleration/braking berbasis delta-time, mengikuti arah pandang pada bidang horizontal, dan menolak kenaikan terrain yang menyerupai dinding. Mini-map gelap menampilkan posisi pengguna, arah pandang, dan jalur air jika analisis hidrologi sudah dijalankan.

FPV selalu menggunakan texture permukaan asli/orthophoto walaupun layer analisis sedang aktif pada mode peta. Input keyboard ditangkap pada level dokumen agar `WASD` tetap bekerja setelah tombol **View in person** diklik.

Untuk pengalaman lapangan yang representatif, gunakan DTM drone beresolusi tinggi. SRTM 30 meter hanya memadai untuk bentuk bentang alam umum, bukan detail parit atau jalan kebun.

## Survey blok kebun

1. Klik **Ukur area** lalu tap minimal tiga titik batas blok pada terrain.
2. Panjang setiap sisi, perimeter, dan luas polygon diperbarui secara langsung saat pointer bergerak.
3. Klik **Selesai ukur** untuk menghitung rentang elevasi, rata-rata slope, persentase area S1+S2, dan persentase High/Critical flood susceptibility.
4. Simpan polygon beserta statistiknya dengan **Export GeoJSON** untuk QGIS atau sistem kebun lainnya.

Kompas N–E–S–W mengikuti orientasi kamera pada mode 3D. Pada mode 2D, utara selalu berada di bagian atas layar.

## CRS dan skala pengukuran

- GeoTIFF geographic seperti EPSG:4326 dikonversi dari derajat ke meter berdasarkan latitude lokasi.
- GeoTIFF projected/UTM seperti EPSG:32748 memakai koordinat easting/northing dan linear unit dari metadata GeoTIFF.
- UI menampilkan EPSG, zona UTM, dan resolusi grid kerja dalam meter/pixel.
- Export waterway dan polygon mempertahankan koordinat sumber serta menyertakan identitas CRS untuk data projected.
- D8 memperhitungkan ukuran pixel X/Y sehingga raster dengan pixel persegi panjang tidak lagi dianggap memiliki jarak tetangga yang sama.

Jika CRS tidak ditemukan, viewer tetap membuka raster dengan asumsi satu unit koordinat sama dengan satu meter dan menandainya sebagai `CRS tidak ditemukan`. Tetapkan CRS yang benar di QGIS/ODM sebelum memakai hasil untuk keputusan lapangan.
