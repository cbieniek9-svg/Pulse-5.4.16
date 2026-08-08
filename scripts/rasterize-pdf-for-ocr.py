"""Rasterize PDF pages to PNG for OCR (image-only / scanned PDFs). Requires: pip install pymupdf"""
import os
import sys


def main():
    if len(sys.argv) < 3:
        print('usage: rasterize-pdf-for-ocr.py <input.pdf> <output_dir>', file=sys.stderr)
        sys.exit(2)
    import fitz  # PyMuPDF

    src, out_dir = sys.argv[1], sys.argv[2]
    os.makedirs(out_dir, exist_ok=True)
    doc = fitz.open(src)
    written = []
    try:
        for i in range(doc.page_count):
            page = doc[i]
            pix = page.get_pixmap(matrix=fitz.Matrix(4, 4), alpha=False)
            name = os.path.join(out_dir, f'scan-page-{i + 1:03d}.png')
            pix.save(name)
            written.append(name)
    finally:
        doc.close()
    for p in written:
        print(p)


if __name__ == '__main__':
    main()
