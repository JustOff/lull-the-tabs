#!/bin/sh

list_files() {
	find -maxdepth 1 -mindepth 1 -not -iregex '^./\(.git\|.gitignore\|update.xml\|LICENSE\|README.md\|.*\.\(cmd\|xpi\|exe\|sh\)$\)' -print0
}
zip_with_p7z() {
	list_files | xargs -0 $Zip_Archiver a . -so -tzip > $XPI -mmt=1 -mx=9
}
zip_with_InfoZip() {
	list_files | xargs -0 zip -r9q - > $XPI
}

VER=1.5.2
sed -i "s/version>.+?</version>$VER</" install.rdf
sed -i -E "s/version>.+?</version>$VER</; s/download\/.+?\/lull-the-tabs-.+?\.xpi/download\/$VER\/lull-the-tabs-$VER\.xpi/" update.xml

XPI=lull-the-tabs-$VER.xpi

Zip_Archiver=$(which 7za 7z zip | head -1 | rev | cut -f1 -d/ | rev)

case $Zip_Archiver in
    7za|7z) zip_with_p7z
;;
    zip) zip_with_InfoZip
;;
    ""|*) echo "Error: You must install 7za, 7z, or zip (infozip)."; exit 1
;;
esac
