import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onlyInvites, replyNotUnderstood, saysNotUnderstood } from './notUnderstood.ts';

test('the live replies that did not understand are read as such', () => {
  assert.ok(saysNotUnderstood('Уучлаарай, ойлгосонгүй. Асуух зүйл байвал бичээрэй.'));
  assert.ok(onlyInvites('Сайн байна уу. Танд ямар нэг зүйл асуух зүйл байвал бидэнд хэлээрэй, туслахад бэлэн байна.'));
});

test('an answer, a greeting row and a thanks row are not', () => {
  for (const r of [
    'Эмэгтэй тайралт 55,000₮ байна. Өөр асуух зүйл байвал бичээрэй.',
    'Сайн байна уу! Tara Salon-д тавтай морил.',
    'Манай салон Яармагийн Номин Хайпермаркетын баруун талд байрладаг.',
  ]) assert.equal(replyNotUnderstood(r), false, r);
});
