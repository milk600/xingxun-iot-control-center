@echo off
if exist Objects rmdir /s /q Objects
if exist Listings rmdir /s /q Listings
mkdir Objects
mkdir Listings
echo Clean complete. Now use Project - Rebuild all target files in Keil.
pause
