const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');

// Configuration
const VERSION = process.env.VERSION || '1.0.0';
const UPDATE_DIR = path.join(__dirname, 'docs', 'app-updates');
const APP_DIR = path.join(__dirname, 'app');

// Ensure updates directory exists
if (!fs.existsSync(UPDATE_DIR)) {
    fs.mkdirSync(UPDATE_DIR, { recursive: true });
}

// Create a zip file of the app directory
const output = fs.createWriteStream(path.join(UPDATE_DIR, `${VERSION}.zip`));
const archive = archiver('zip', { zlib: { level: 9 } });

output.on('close', () => {
    const fileSize = archive.pointer();
    const filePath = path.join(UPDATE_DIR, `${VERSION}.zip`);
    
    // Calculate SHA-256 hash
    const fileBuffer = fs.readFileSync(filePath);
    const hashSum = crypto.createHash('sha256');
    hashSum.update(fileBuffer);
    const hash = hashSum.digest('hex');

    // Create manifest
    const manifest = {
        version: VERSION,
        channel: 'production',
        files: [{
            url: `/${VERSION}.zip`,
            size: fileSize,
            hash: `sha256-${hash}`
        }]
    };

    // Write manifest
    fs.writeFileSync(
        path.join(UPDATE_DIR, 'manifest.json'),
        JSON.stringify(manifest, null, 2)
    );

    console.log(`\nUpdate packaged successfully:
Size: ${fileSize} bytes
Hash: sha256-${hash}
Manifest: ${UPDATE_DIR}/manifest.json
Zip: ${UPDATE_DIR}/${VERSION}.zip`);

    console.log('\nTo deploy:');
    console.log('1. Commit the docs/app-updates directory to your repository');
    console.log('2. Enable GitHub Pages in your repository settings');
    console.log('3. Make sure your repository is set to deploy from the root directory');
});

archive.on('error', (err) => {
    throw err;
});

archive.pipe(output);
archive.directory(APP_DIR, false);
archive.finalize(); 