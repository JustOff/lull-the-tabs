@echo off
set VER=1.5.2

sed -i -E "s/version>.+?</version>%VER%</" install.rdf
sed -i -E "s/version>.+?</version>%VER%</; s/download\/.+?\/lull-the-tabs-.+?\.xpi/download\/%VER%\/lull-the-tabs-%VER%\.xpi/" update.xml

set XPI=lull-the-tabs-%VER%.xpi
if exist %XPI% del %XPI%
zip -r9q %XPI% * -x .git/* .gitignore update.xml LICENSE README.md *.cmd *.xpi *.exe
