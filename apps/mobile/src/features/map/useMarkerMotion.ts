/**
 * Haritadaki kişi pininin yumuşak hareketi (iOS + Android, aynı kod yolu).
 *
 * Seçilen yaklaşım: react-native-maps `MarkerAnimated` + `AnimatedRegion` (JS sürücülü Animated.timing,
 * core `easeInOutCubic` yumuşatması). Neden native `animateMarkerToCoordinate` değil:
 *  - react-native-maps 1.29'da iOS Google oluşturucusunda bu komut animasyon YAPMAZ, koordinatı doğrudan
 *    yazar (RNMapsGoogleMarkerView.mm `animateToCoordinates`): iOS'ta pin yine sıçrardı.
 *  - Android'deki ObjectAnimator kendi hızlanma eğrisini kullanır; iki platformda farklı hareket olurdu.
 *  - Animated.timing kesilebilir: yeni konum animasyon sürerken gelirse `stopAnimation` pinin O ANKİ
 *    yerini verir ve yeni animasyon oradan başlar (geri sıçrama yok).
 * Maliyet: örnekler 10–60 sn arayla gelir, animasyon en çok 2 sn sürer; birkaç pin için JS yükü önemsizdir.
 * Kural kararları (sıçrama/ara/ilk konum) core `markerTransition` ile `planMarkerMove`'dadır.
 */
import { easeInOutCubic } from '@konum/core';
import { useEffect, useRef } from 'react';
import { Animated } from 'react-native';
import { AnimatedRegion } from 'react-native-maps';
import { planMarkerMove, unwrapLng } from './markerMotionPlan';

export function useMarkerMotion(lat: number, lng: number, timestamp: number | undefined): AnimatedRegion {
  const regionRef = useRef<AnimatedRegion | null>(null);
  regionRef.current ??= new AnimatedRegion({ latitude: lat, longitude: lng, latitudeDelta: 0, longitudeDelta: 0 });
  const region = regionRef.current;
  const last = useRef<{ lat: number; lng: number; timestamp: number } | null>(null);

  useEffect(() => {
    const next = { lat, lng, timestamp: timestamp ?? Date.now() };
    const step = planMarkerMove(last.current, next);
    if (step.kind === 'ignore') return;
    last.current = next;
    const latV = region.latitude as Animated.Value;
    const lngV = region.longitude as Animated.Value;
    region.stopAnimation((current) => {
      if (step.kind === 'snap') {
        latV.setValue(lat);
        lngV.setValue(lng);
        return;
      }
      const toLng = unwrapLng(current.longitude, lng);
      const cfg = { duration: step.durationMs, easing: easeInOutCubic, useNativeDriver: false } as const;
      Animated.parallel([Animated.timing(latV, { ...cfg, toValue: lat }), Animated.timing(lngV, { ...cfg, toValue: toLng })]).start(({ finished }) => {
        if (finished && toLng !== lng) lngV.setValue(lng);
      });
    });
  }, [lat, lng, timestamp, region]);

  useEffect(() => () => region.stopAnimation(() => undefined), [region]);

  return region;
}
