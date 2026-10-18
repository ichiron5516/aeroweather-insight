cd /home/claude/th
ls pdf/*.pdf | xargs -P 8 -I{} sh -c 'b=$(basename {} .pdf); pdftoppm -r 300 -gray -png {} ocr/$b'
ls ocr/*.png | grep -v _c.png | xargs -P 8 -n 4 python3 /home/claude/hk/tools/hk_clean.py
ls ocr/*_c.png | xargs -P 8 -I{} sh -c 'tesseract "{}" "$(echo {} | sed s/.png//)" --psm 6 >/dev/null 2>&1' {}
echo DONE > ocr/_done
