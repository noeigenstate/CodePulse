#pragma once
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"
#define GPIO_NUM_4 4
#define GPIO_NUM_5 5
#define GPIO_NUM_6 6
#define GPIO_NUM_7 7
#define GPIO_NUM_16 16
#define GPIO_NUM_17 17
#define SPI2_HOST 2
#define SPI_DMA_CH_AUTO 3
typedef void *spi_device_handle_t;
typedef struct { int mosi_io_num,miso_io_num,sclk_io_num,quadwp_io_num,quadhd_io_num,max_transfer_sz; } spi_bus_config_t;
typedef struct { int clock_speed_hz,mode,spics_io_num,queue_size; } spi_device_interface_config_t;
typedef struct { size_t length; const void *tx_buffer; } spi_transaction_t;
esp_err_t spi_bus_initialize(int host,const spi_bus_config_t *cfg,int dma);
esp_err_t spi_bus_add_device(int host,const spi_device_interface_config_t *cfg,spi_device_handle_t *out);
esp_err_t spi_bus_free(int host);
esp_err_t spi_device_polling_transmit(spi_device_handle_t dev,spi_transaction_t *tx);
int gpio_get_level(int pin);
void gpio_set_level(int pin,int level);
int64_t esp_timer_get_time(void);
void esp_rom_delay_us(uint32_t us);
void vTaskDelay(int ticks);
#define pdMS_TO_TICKS(ms) ((ms)/10)
#define ESP_RETURN_ON_ERROR(expr,tag,...) do { esp_err_t e_=(expr); if(e_!=ESP_OK) return e_; } while(0)
#define ESP_LOGI(tag,...) ((void)(tag))
#define ESP_LOGE(tag,...) ((void)(tag))
