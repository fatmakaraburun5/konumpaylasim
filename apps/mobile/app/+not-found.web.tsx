/**
 * YALNIZCA web önizleme: tek dosyalık derleme herhangi bir alt yoldan (ör. /demo/konum/index.html) ya da
 * korumalı bir iframe içinden açılabilir; tanınmayan her yol kök "/" yoluna yönlendirilir ve oradan
 * kimlik kapısı uygun ekranı (giriş ya da harita) açar.
 */
import { Redirect } from 'expo-router';

export default function NotFound() {
  return <Redirect href="/" />;
}
