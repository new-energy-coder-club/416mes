# S3 新增依赖记录

- `@zxing/library` **0.21.3**，MIT，npm报告unpacked 9,459,080 bytes。本地离线浏览器包 `vendor/zxing-0.21.3.min.js` 336,008 bytes；许可证 `vendor/zxing-LICENSE`。用途：实际Code128像素解码，不依赖BarcodeDetector可用性。现有jsQR保留LOC/CTN二维码。
- `linkedom` **0.18.12**，ISC，npm报告unpacked 919,721 bytes。仅devDependency，用于真实DOM事件测试，不进入浏览器包。
- `playwright-core` **1.58.2**（Apache-2.0）仅devDependency，使用系统 `/usr/bin/chromium`，不安装浏览器或改全局环境。用于整个index.html启动、真实IndexedDB、390px窄屏和刷新恢复；context.route在导航前阻断所有非localhost-origin网络，API全部隔离拦截。
- 浏览器门禁独立执行 `npm run test:browser`，测试文件 `test/item-browser.browser.cjs`。CI必须预装Chromium或设置 `ITM_TEST_CHROMIUM` 指向已安装可执行文件；缺少浏览器命令明确失败，不静默skip，`npm test`通过不等于浏览器门禁通过。
- 所有直接版本锁定并更新本worktree package-lock。npm install创建本worktree node_modules，没有修改父node_modules。
- 合成fixture `test/fixtures/item-code128.json` 为Code128B条宽规格，测试光栅化成RGBA再调用实际ZXing解码。首次测试失败归因人工checksum写成44，按规范权重校验应77；修正后5/5通过。没有mock文本解码结果。
- 合成夹具通过不代表Android/iOS/飞书相机硬件已验证。真实设备、HTTPS权限及现场条码质量仍为外部门禁。
