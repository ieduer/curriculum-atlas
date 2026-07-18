# B1 OCR writer audit asset

`ocr-pdf-paddle.py` is the byte-exact OCR writer read back from the immutable
DMITPro2 B1 predecessor before the B3 seed transition. It is retained only as
an audit fixture and is never an executable production entrypoint.

- B1 full-file SHA-256: `b4ea873026fb4d2da2efb921ddac3974a48db703143ff53aff3ebeae48d9b048`
- Seed-aware writer SHA-256: `3176d267c681b2764d4ff81f7e7b6748c174ee62854a11a2529ccfb355a364f3`
- Byte-identical suffix from `    pipeline = PaddleOCRVL(` through EOF:
  11,430 bytes, SHA-256
  `4edade704624f0bac5bcd76eeb113a07452a57040e4fd949609d319f49c2b4ca`

The source-audit test fails closed if either full file, the suffix boundary,
the 240 DPI default, Paddle inference call, or page artifact contract changes.
