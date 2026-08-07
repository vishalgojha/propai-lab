-- These columns store the WhatsApp/WhatsMeow connection key (for example
-- phone-2e12a9961676), not public.brokers.id.  The old broker_id name implied
-- a broken BIGINT foreign-key relationship and caused incorrect joins.

DO $$
BEGIN
  IF to_regclass('public.broker_whatsapp_devices') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'broker_whatsapp_devices'
         AND column_name = 'broker_id'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'broker_whatsapp_devices'
         AND column_name = 'whatsapp_connection_key'
     ) THEN
    ALTER TABLE public.broker_whatsapp_devices
      RENAME COLUMN broker_id TO whatsapp_connection_key;
  END IF;

  IF to_regclass('public.broker_whatsapp_device_history') IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'broker_whatsapp_device_history'
         AND column_name = 'broker_id'
     )
     AND NOT EXISTS (
       SELECT 1
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND table_name = 'broker_whatsapp_device_history'
         AND column_name = 'whatsapp_connection_key'
     ) THEN
    ALTER TABLE public.broker_whatsapp_device_history
      RENAME COLUMN broker_id TO whatsapp_connection_key;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.broker_whatsapp_devices') IS NOT NULL THEN
    COMMENT ON COLUMN public.broker_whatsapp_devices.whatsapp_connection_key IS
      'WhatsMeow connection/session key; not public.brokers.id.';
  END IF;

  IF to_regclass('public.broker_whatsapp_device_history') IS NOT NULL THEN
    COMMENT ON COLUMN public.broker_whatsapp_device_history.whatsapp_connection_key IS
      'Historical WhatsMeow connection/session key; not public.brokers.id.';
  END IF;
END $$;
